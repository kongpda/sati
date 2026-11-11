import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { shortHandle } from "../domain/ids.js";
import { ENTITY_SCHEMAS, type EntityMap, LIMITS, type Task } from "../domain/schemas.js";
import { listAll, logActivity, nowIso, parseInput, type ServiceContext } from "./context.js";
import { linkProblems } from "./doctor.js";

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

/** True for a private note or card, which never leaves this machine's database. */
export const isPrivate = (record: object): boolean =>
  "private" in record && record.private === true;

/** Every snapshot record of the project except private ones, soft-deleted ones as tombstones. */
export async function snapshotRecords(ctx: ServiceContext): Promise<SnapshotRecord[]> {
  return ctx.store.read(async (r) => {
    const out: SnapshotRecord[] = [];
    for (const entity of SNAPSHOT_ENTITIES) {
      for (const record of await listAll(r, ctx, entity, { includeDeleted: true })) {
        // Private notes and cards stay in this machine's database.
        if (isPrivate(record)) continue;
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
  /**
   * Cycles and broken links among the imported tasks. A merge can make them, so the import does
   * not refuse (that would stop every git hook until someone edited `.sati/` by hand); it says so.
   */
  problems: string[];
}

/** True when `incoming` should replace `stored`: a higher version, or the same one edited later. */
function isNewer(incoming: { version: number; updatedAt: string }, stored: typeof incoming) {
  return (
    incoming.version > stored.version ||
    (incoming.version === stored.version && incoming.updatedAt > stored.updatedAt)
  );
}

/**
 * The actor whose live claim an imported task replaces with someone else's. Without a server two
 * people can claim one task before their files meet; the one who lost must hear of it.
 */
function lostClaim(stored: Task, incoming: Task, now: string): string | undefined {
  const mine = stored.claim;
  const theirs = incoming.claim;
  if (!mine || !theirs || mine.leaseUntil <= now || mine.actorId === theirs.actorId) {
    return undefined;
  }
  return mine.actorId;
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
  let newer = false;
  for (const { entity, source, record } of items) {
    const r = ENTITY_SCHEMAS[entity].safeParse(record);
    if (!r.success) {
      const issue = r.error.issues[0];
      // Fields this version does not know: the files come from a newer sati on another clone.
      newer ||= r.error.issues.some((i) => i.code === "unrecognized_keys");
      bad.push(`${source}: ${issue?.path.join(".") || "record"}: ${issue?.message}`);
    } else if (r.data.projectId !== ctx.projectId) {
      bad.push(`${source}: belongs to project ${r.data.projectId}, not ${ctx.projectId}`);
    } else {
      parsed.push({ entity, record: r.data } as SnapshotRecord);
    }
  }
  if (bad.length > 0) {
    throw new SatiError("VALIDATION", `Invalid snapshot records: ${bad.slice(0, 3).join("; ")}`, {
      hint: newer
        ? "Nothing was imported. A newer sati wrote these files; update sati on this machine and import again."
        : "Nothing was imported. Fix or restore these files from git.",
      details: { invalid: bad },
    });
  }

  return ctx.store.write(async (w) => {
    const result: ImportResult = { imported: [], unchanged: 0, problems: [] };
    const now = nowIso(ctx);
    const lost: string[] = [];
    for (const { entity, record } of parsed) {
      const stored = await w.get(entity, record.id);
      // A file never replaces a private record, and a file marked private is not memory to take
      // in: private items are never exported, so one in `.sati/` was put there by hand.
      if (
        isPrivate(record) ||
        (stored && isPrivate(stored)) ||
        (stored && !isNewer(record, stored))
      ) {
        result.unchanged++;
        continue;
      }
      if (stored) await w.update(entity, record, stored.version);
      else await w.insert(entity, record);
      const loser =
        entity === "task" && stored ? lostClaim(stored as Task, record, now) : undefined;
      await logActivity(w, ctx, "import", entity, record.id, {
        version: record.version,
        from: stored?.version ?? null,
        ...(loser ? { lostClaim: loser } : {}),
      });
      if (loser && entity === "task") {
        const name = (await w.get("actor", loser))?.name ?? "someone";
        lost.push(
          `${shortHandle(record.id)} "${record.title}" was claimed on two machines before their files met. The later claim was kept; ${name} no longer holds the task.`,
        );
      }
      result.imported.push({ entity, id: record.id, version: record.version });
    }
    const tasks = result.imported.filter((i) => i.entity === "task").map((i) => i.id);
    if (tasks.length > 0) result.problems = await linkProblems(w, ctx, tasks);
    result.problems.push(...lost);
    return result;
  });
}
