import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";
import {
  type ImportRecordsInput,
  type ImportResult,
  importRecords,
  isPrivate,
  SatiError,
  type SecretFinding,
  type ServiceContext,
  SNAPSHOT_DIRS,
  SNAPSHOT_ENTITIES,
  type SnapshotEntity,
  type SnapshotRecord,
  scanRecord,
  snapshotRecords,
} from "@sati/core";
import type { WrittenRecord } from "./debounce.js";
import { decodeRecord, encodeRecord, snapshotEntityOf } from "./format.js";

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

/** Writes through a temp file and a rename, so readers never see a half-written file. */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export interface ExportResult {
  /** Files written, relative to the snapshot folder. */
  written: string[];
  unchanged: number;
  /** Files left alone because they hold a newer version than the database: import them first. */
  newer: string[];
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
  const records = opts.only ? await readRecords(ctx, opts.only) : await snapshotRecords(ctx);
  const result: ExportResult = { written: [], unchanged: 0, newer: [] };
  const changed: { rec: SnapshotRecord; rel: string; file: string; content: string }[] = [];
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
    changed.push({ rec, rel, file, content });
  }
  // Only files about to change are scanned: an unchanged file was scanned when it was written.
  refuseSecrets(changed.flatMap(({ rec }) => scanRecord(rec.entity, rec.record)));
  for (const { rec, rel, file, content } of changed) {
    mkdirSync(join(dir, SNAPSHOT_DIRS[rec.entity]), { recursive: true });
    writeAtomic(file, content);
    result.written.push(rel);
  }
  return result;
}

/** Shown in full up to this many; the rest are counted. */
const MAX_LISTED = 10;

/**
 * Fails the whole export when any record holds a secret, before any file is written, so a
 * commit never carries one. The message names the record and field, never the secret.
 */
function refuseSecrets(found: SecretFinding[]): void {
  if (found.length === 0) return;
  const lines = found
    .slice(0, MAX_LISTED)
    .map((f) => `  ${f.entity} ${f.id}, field ${f.field}: ${f.kind}`);
  if (found.length > MAX_LISTED) lines.push(`  and ${found.length - MAX_LISTED} more`);
  throw new SatiError(
    "VALIDATION",
    `Export refused: ${found.length} record field(s) look like they contain a secret.\n${lines.join("\n")}`,
    {
      hint: "Remove the secret from each field listed (rotate it if it was real), then export again. Nothing was written to .sati/.",
      details: found,
    },
  );
}

/** Reads every record file under `dir`. Unparseable files fail the whole read. */
export function readSnapshot(dir: string): ImportRecordsInput {
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
  return importRecords(ctx, readSnapshot(dir));
}
