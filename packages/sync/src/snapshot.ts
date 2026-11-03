import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BrainError,
  type ImportRecordsInput,
  type ImportResult,
  importRecords,
  type ServiceContext,
  SNAPSHOT_DIRS,
  SNAPSHOT_ENTITIES,
  snapshotRecords,
} from "@brain/core";

/** A record file larger than this cannot be valid (bodies are capped at 100 KB). */
const MAX_FILE_BYTES = 1024 * 1024;

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
}

/**
 * Writes one file per record to `dir` (the `.brain/` folder), tombstones included. Only files
 * whose content changed are rewritten. Files with no matching record are left alone: they may be
 * a teammate's records that are not imported yet.
 */
export async function exportSnapshot(ctx: ServiceContext, dir: string): Promise<ExportResult> {
  const result: ExportResult = { written: [], unchanged: 0 };
  for (const { entity, record } of await snapshotRecords(ctx)) {
    const rel = join(SNAPSHOT_DIRS[entity], `${record.id}.json`);
    const file = join(dir, rel);
    const content = stableJson(record);
    if (existsSync(file) && readFileSync(file, "utf8") === content) {
      result.unchanged++;
      continue;
    }
    mkdirSync(join(dir, SNAPSHOT_DIRS[entity]), { recursive: true });
    writeAtomic(file, content);
    result.written.push(rel);
  }
  return result;
}

/** Reads every record file under `dir`. Unparseable files fail the whole read. */
export function readSnapshot(dir: string): ImportRecordsInput {
  const out: ImportRecordsInput = [];
  for (const entity of SNAPSHOT_ENTITIES) {
    const folder = join(dir, SNAPSHOT_DIRS[entity]);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder).sort()) {
      if (!name.endsWith(".json")) continue;
      const source = join(SNAPSHOT_DIRS[entity], name);
      const file = join(folder, name);
      const fail = (why: string) => {
        throw new BrainError("VALIDATION", `Invalid snapshot file ${source}: ${why}`, {
          hint: "Nothing was imported. Fix or restore the file from git.",
        });
      };
      if (statSync(file).size > MAX_FILE_BYTES) fail("larger than 1 MB");
      let record: unknown;
      try {
        record = JSON.parse(readFileSync(file, "utf8"));
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      const id = (record as { id?: unknown } | null)?.id;
      if (`${String(id)}.json` !== name) fail("the file name does not match the record id");
      out.push({ entity, source, record });
    }
  }
  return out;
}

/** Imports the snapshot in `dir` into the DB; see `importRecords` for the rules. */
export async function importSnapshot(ctx: ServiceContext, dir: string): Promise<ImportResult> {
  return importRecords(ctx, readSnapshot(dir));
}
