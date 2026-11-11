import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type ImportRecordsInput,
  type ImportResult,
  importRecords,
  isPrivate,
  SatiError,
  type ServiceContext,
  SNAPSHOT_DIRS,
  SNAPSHOT_ENTITIES,
  type SnapshotEntity,
  type SnapshotRecord,
  scanRecord,
  snapshotRecords,
} from "@sati/core";
import { writeFileAtomic } from "./atomic.js";
import type { WrittenRecord } from "./debounce.js";
import { decodeRecord, encodeRecord, snapshotEntityOf } from "./format.js";
import { mergeByStamps } from "./merge.js";

type Obj = Parameters<typeof mergeByStamps>[0];
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** A record file larger than this cannot be valid (bodies are capped at 100 KB). */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Most files `readSnapshot` accepts, matching the record cap `importRecords` enforces; counted
 * while reading so a huge folder fails before it is all in memory.
 */
const MAX_FILES = 100_000;

/** Most bytes of record files read in total: 256 MB, far above any real project (a record is
 * typically a few KB) yet small enough to hold in memory. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** JSON with object keys sorted at every level, 2-space indent and a trailing newline. */
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** How old a leftover temp file must be before a full export removes it. */
const STALE_TMP_MS = 60_000;

/**
 * Refuses a snapshot folder or record folder that is a symlink. A committed `.sati/tasks` link
 * would make import read, and export write, files outside the repository.
 */
function refuseLinkedFolders(dir: string): void {
  for (const rel of [".", ...Object.values(SNAPSHOT_DIRS)]) {
    // lstat, not existsSync: a dangling link must be refused too, not taken as missing.
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(join(dir, rel));
    } catch {
      continue;
    }
    if (!info.isDirectory()) {
      const shown = rel === "." ? "the snapshot folder" : `${rel}/`;
      throw new SatiError(
        "VALIDATION",
        `Invalid snapshot: ${shown} is not a folder (symlinks are refused).`,
        {
          hint: "Replace it with a real folder, or restore it from git. Nothing was read or written.",
        },
      );
    }
  }
}

/**
 * Removes temp files a killed export left behind (`<id>.json.<pid>.tmp`), so pre-commit's
 * `git add -A` does not commit them. Only old ones: a younger file may belong to a live export.
 */
function removeStaleTemps(dir: string, now: number): void {
  for (const rel of Object.values(SNAPSHOT_DIRS)) {
    const folder = join(dir, rel);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".tmp")) continue;
      const file = join(folder, name);
      // Another export may remove the same file between the listing and this look.
      const info = lstatSync(file, { throwIfNoEntry: false });
      if (info?.isFile() && now - info.mtimeMs > STALE_TMP_MS) rmSync(file, { force: true });
    }
  }
}

export interface ExportResult {
  /** Files written, relative to the snapshot folder. */
  written: string[];
  unchanged: number;
  /** Files left alone because they hold a newer version than the database: import them first. */
  newer: string[];
  /**
   * Records not written because a field looks like a secret. The rest of the export still runs,
   * so one bad record cannot stop every later export. Never carries the secret itself.
   */
  refused: RefusedRecord[];
}

/** A record the export refused to write; `field` and `kind` as in a secret finding. */
export interface RefusedRecord {
  path: string;
  field: string;
  kind: string;
}

/** The `version` a record file holds, or 0 when it cannot be read. */
function fileVersion(text: string): number {
  try {
    const value: unknown = JSON.parse(text);
    const version = (value as { version?: unknown } | null)?.version;
    return typeof version === "number" ? version : 0;
  } catch {
    return 0;
  }
}

export interface ExportOptions {
  /**
   * Export only these records (the ones a process just wrote) instead of every record. A full
   * export also repairs files changed outside sati, so pre-commit and `sati sync export` run one.
   */
  only?: readonly WrittenRecord[];
}

const isSnapshotEntity = (e: string): e is SnapshotEntity =>
  (SNAPSHOT_ENTITIES as readonly string[]).includes(e);

/** The current state of the given records, tombstones included, in one consistent read. */
function readRecords(
  ctx: ServiceContext,
  refs: readonly WrittenRecord[],
): Promise<SnapshotRecord[]> {
  return ctx.store.read(async (r) => {
    const out: SnapshotRecord[] = [];
    const seen = new Set<string>();
    for (const { entity, id } of refs) {
      if (!isSnapshotEntity(entity) || seen.has(`${entity}:${id}`)) continue;
      seen.add(`${entity}:${id}`);
      const record = await r.get(entity, id);
      // Private notes and cards stay in this machine's database, as in a full export.
      if (record?.projectId === ctx.projectId && !isPrivate(record))
        out.push({ entity, record } as SnapshotRecord);
    }
    return out;
  });
}

/**
 * Writes one file per record to `dir` (the `.sati/` folder), tombstones included. Only files
 * whose content changed are rewritten. Files with no matching record are left alone: they may be
 * a teammate's records that are not imported yet. For the same reason a file at a higher version
 * than the database is never overwritten: an import that did not run, or was refused, must not
 * turn into the older copy being committed over a teammate's edit.
 */
export async function exportSnapshot(
  ctx: ServiceContext,
  dir: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  refuseLinkedFolders(dir);
  if (!opts.only) removeStaleTemps(dir, Date.now());
  const records = opts.only ? await readRecords(ctx, opts.only) : await snapshotRecords(ctx);
  const result: ExportResult = { written: [], unchanged: 0, newer: [], refused: [] };
  for (const rec of records) {
    // Reported paths use `/` on every OS, like git does.
    const rel = posix.join(SNAPSHOT_DIRS[rec.entity], `${rec.record.id}.json`);
    const file = join(dir, rel);
    const content = stableJson(encodeRecord(rec.record));
    const onDisk = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (onDisk === content) {
      result.unchanged++;
      continue;
    }
    if (onDisk !== undefined && fileVersion(onDisk) > rec.record.version) {
      result.newer.push(rel);
      continue;
    }
    // Only files about to change are scanned: an unchanged file was scanned when it was written.
    // Writes refuse secrets already; this catches records saved by an older version or by hand.
    const found = scanRecord(rec.entity, rec.record);
    if (found.length > 0) {
      for (const { field, kind } of found) result.refused.push({ path: rel, field, kind });
      continue;
    }
    mkdirSync(join(dir, SNAPSHOT_DIRS[rec.entity]), { recursive: true });
    writeFileAtomic(file, content);
    result.written.push(rel);
  }
  return result;
}

/** Shown in full up to this many; the rest are counted. */
const MAX_LISTED = 10;

/**
 * The error for records an export refused, so `sati export` (and with it pre-commit) fails while
 * a secret is waiting to be committed. The message names the file and field, never the secret.
 */
export function refusedError(refused: readonly RefusedRecord[]): SatiError {
  const lines = refused.slice(0, MAX_LISTED).map((f) => `  ${f.path}, field ${f.field}: ${f.kind}`);
  if (refused.length > MAX_LISTED) lines.push(`  and ${refused.length - MAX_LISTED} more`);
  return new SatiError(
    "VALIDATION",
    `Export refused ${refused.length} record field(s) that look like they contain a secret.\n${lines.join("\n")}`,
    {
      hint: "Remove the secret from each field listed (rotate it if it was real), then export again. The other records were exported.",
      details: refused,
    },
  );
}

/** Reads every record file under `dir`. Unparseable files fail the whole read. */
export function readSnapshot(dir: string): ImportRecordsInput {
  refuseLinkedFolders(dir);
  const out: ImportRecordsInput = [];
  let count = 0;
  let total = 0;
  for (const entity of SNAPSHOT_ENTITIES) {
    const folder = join(dir, SNAPSHOT_DIRS[entity]);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      if (!name.endsWith(".json")) continue;
      const source = posix.join(SNAPSHOT_DIRS[entity], name);
      const file = join(folder, name);
      const fail = (why: string) => {
        throw new SatiError("VALIDATION", `Invalid snapshot file ${source}: ${why}`, {
          hint: "Nothing was imported. Fix or restore the file from git.",
        });
      };
      // lstat, not stat: a symlink pushed into .sati/ must not make us read files outside the repo.
      const info = lstatSync(file);
      if (!info.isFile()) fail("not a regular file (symlinks and folders are refused)");
      if (info.size > MAX_FILE_BYTES) fail("larger than 1 MB");
      count += 1;
      total += info.size;
      if (count > MAX_FILES) fail(`more than ${MAX_FILES} record files`);
      if (total > MAX_TOTAL_BYTES) fail("the snapshot is larger than 256 MB in total");
      let record: unknown;
      try {
        record = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        // The parser's message can quote the file's content; keep it out of the error.
        fail("not valid JSON");
      }
      const id = (record as { id?: unknown } | null)?.id;
      if (`${String(id)}.json` !== name) fail("the file name does not match the record id");
      // A record of another entity in this folder stays as it is, and validation names it.
      const full = snapshotEntityOf(record) === entity ? decodeRecord(record) : record;
      out.push({ entity, source, record: full });
    }
  }
  return out;
}

/** Imports the snapshot in `dir` into the DB; see `importRecords` for the rules. */
export async function importSnapshot(ctx: ServiceContext, dir: string): Promise<ImportResult> {
  return importRecords(ctx, await joinTies(ctx, readSnapshot(dir)));
}

/**
 * A file and the DB at the same version with different stamps changed apart without a git merge:
 * a local edit still inside the export debounce, or kept from export by a crash, when a pull
 * brings a teammate's file. Import keeps whole records, so one side's edit would be lost; merge
 * the two field by field instead. The merged record is one version past both, so it is imported
 * and then exported over the file.
 */
async function joinTies(ctx: ServiceContext, records: ImportRecordsInput) {
  return ctx.store.read(async (r) => {
    const out: ImportRecordsInput = [];
    for (const item of records) {
      const file = item.record;
      const id = isObj(file) ? file.id : undefined;
      const stored = typeof id === "string" ? await r.get(item.entity, id) : undefined;
      const tie =
        isObj(file) &&
        stored !== undefined &&
        stored.version === file.version &&
        isObj(file.stamps) &&
        !isDeepStrictEqual(stored.stamps, file.stamps) &&
        // Compared as files: a task saved before `effort` has no effort stamp in the DB, and its
        // file reads back with the shared one. That is not a change.
        !isDeepStrictEqual(encodeRecord(stored), encodeRecord(file));
      out.push(
        tie ? { ...item, record: mergeByStamps(stored as unknown as Obj, file).record } : item,
      );
    }
    return out;
  });
}
