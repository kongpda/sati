import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { ENTITY_SCHEMAS, type EntityMap, LIMITS } from "../domain/schemas.js";
import { listAll, logActivity, parseInput, type ServiceContext } from "./context.js";

/** The records the git snapshot carries. Actors, locks and activity stay machine-local. */
export const SNAPSHOT_ENTITIES = [
  "milestone",
  "feature",
  "task",
  "decision",
  "note",
  "context",
] as const;
export type SnapshotEntity = (typeof SNAPSHOT_ENTITIES)[number];

/** Folder of each entity under `.sati/`. */
export const SNAPSHOT_DIRS: Record<SnapshotEntity, string> = {
  milestone: "milestones",
  feature: "features",
  task: "tasks",
  decision: "decisions",
  note: "notes",
  context: "context",
};

export type SnapshotRecord = {
  [E in SnapshotEntity]: { entity: E; record: EntityMap[E] };
}[SnapshotEntity];

/** Every snapshot record of the project, soft-deleted ones included as tombstones. */
export async function snapshotRecords(ctx: ServiceContext): Promise<SnapshotRecord[]> {
  return ctx.store.read(async (r) => {
    const out: SnapshotRecord[] = [];
    for (const entity of SNAPSHOT_ENTITIES) {
      for (const record of await listAll(r, ctx, entity, { includeDeleted: true })) {
        out.push({ entity, record } as SnapshotRecord);
      }
    }
    return out;
  });
}

/** A snapshot holds far more records than one agent call, so the usual 500-item cap is raised. */
const MAX_RECORDS = 100_000;

export const ImportRecordsInput = z
  .array(
    z.strictObject({
      entity: z.enum(SNAPSHOT_ENTITIES),
      /** Where the record came from (a file path), for error messages. */
      source: z.string().max(LIMITS.path),
      record: z.unknown(),
    }),
  )
  .max(MAX_RECORDS);
export type ImportRecordsInput = z.input<typeof ImportRecordsInput>;

export interface ImportResult {
  imported: { entity: SnapshotEntity; id: string; version: number }[];
  unchanged: number;
}

/** True when `incoming` should replace `stored`: a higher version, or the same one edited later. */
function isNewer(incoming: { version: number; updatedAt: string }, stored: typeof incoming) {
  return (
    incoming.version > stored.version ||
    (incoming.version === stored.version && incoming.updatedAt > stored.updatedAt)
  );
}

/**
 * Upserts snapshot records into the DB in one transaction: new records are inserted, and stored
 * ones are replaced when the incoming copy is newer. Every record is validated first; one bad
 * record rejects the whole import. Each imported record writes an `import` activity row.
 */
export async function importRecords(ctx: ServiceContext, input: unknown): Promise<ImportResult> {
  const items = parseInput(ImportRecordsInput, input);
  const parsed: SnapshotRecord[] = [];
  const bad: string[] = [];
  for (const { entity, source, record } of items) {
    const r = ENTITY_SCHEMAS[entity].safeParse(record);
    if (!r.success) {
      const issue = r.error.issues[0];
      bad.push(`${source}: ${issue?.path.join(".") || "record"}: ${issue?.message}`);
    } else if (r.data.projectId !== ctx.projectId) {
      bad.push(`${source}: belongs to project ${r.data.projectId}, not ${ctx.projectId}`);
    } else {
      parsed.push({ entity, record: r.data } as SnapshotRecord);
    }
  }
  if (bad.length > 0) {
    throw new SatiError("VALIDATION", `Invalid snapshot records: ${bad.slice(0, 3).join("; ")}`, {
      hint: "Nothing was imported. Fix or restore these files from git.",
      details: { invalid: bad },
    });
  }

  return ctx.store.write(async (w) => {
    const result: ImportResult = { imported: [], unchanged: 0 };
    for (const { entity, record } of parsed) {
      const stored = await w.get(entity, record.id);
      if (stored && !isNewer(record, stored)) {
        result.unchanged++;
        continue;
      }
      if (stored) await w.update(entity, record, stored.version);
      else await w.insert(entity, record);
      await logActivity(w, ctx, "import", entity, record.id, {
        version: record.version,
        from: stored?.version ?? null,
      });
      result.imported.push({ entity, id: record.id, version: record.version });
    }
    return result;
  });
}
