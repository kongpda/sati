import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { normalizeLockPath, overlappingPaths } from "../domain/locks.js";
import { LIMITS, LOCK_MODES, type Lock, TaskId } from "../domain/schemas.js";
import type { StorageReader, StorageWriter } from "../ports/storage.js";
import {
  actorName,
  baseFields,
  insertWithLog,
  listAll,
  mustGet,
  nowIso,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";
import { DEFAULT_LEASE_MINUTES } from "./project.js";

const LockPath = z
  .string()
  .min(1)
  .max(LIMITS.path)
  .transform((raw, c) => {
    const p = normalizeLockPath(raw);
    if (p === undefined) {
      c.addIssue({ code: "custom", message: `"${raw}" is not a repo-relative path or glob` });
      return z.NEVER;
    }
    return p;
  });

export const AcquireLockInput = z.strictObject({
  paths: z.array(LockPath).min(1).max(LIMITS.array),
  mode: z.enum(LOCK_MODES).default("exclusive"),
  taskId: TaskId.optional(),
  reason: z.string().max(LIMITS.shortText).default(""),
  leaseMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
});
export const ReleaseLockInput = z.strictObject({ force: z.boolean().optional() });
export type AcquireLockInput = z.input<typeof AcquireLockInput>;
export type ReleaseLockInput = z.input<typeof ReleaseLockInput>;

/** Another agent's live lock that overlaps the requested paths. */
export interface LockOverlap {
  lockId: string;
  actorId: string;
  holderName: string;
  mode: Lock["mode"];
  leaseUntil: string;
  /** `[requested, held]` path pairs that overlap. */
  paths: [string, string][];
}

export interface AcquireLockResult {
  lock: Lock;
  /** Overlaps with other agents' shared locks: allowed, but worth knowing about. */
  warnings: LockOverlap[];
}

const allLocks = (r: StorageReader, ctx: ServiceContext) => listAll(r, ctx, "lock");

export const isLive = (l: Lock, now: string) => l.leaseUntil > now;

/** Other actors' live locks. */
export async function othersLiveLocks(r: StorageReader, ctx: ServiceContext): Promise<Lock[]> {
  const now = nowIso(ctx);
  return (await allLocks(r, ctx)).filter((l) => l.actorId !== ctx.actorId && isLive(l, now));
}

/** Live locks, oldest first. Expired locks are not listed; they no longer block anyone. */
export async function listLocks(ctx: ServiceContext): Promise<Lock[]> {
  const now = nowIso(ctx);
  return ctx.store.read(async (r) => (await allLocks(r, ctx)).filter((l) => isLive(l, now)));
}

/**
 * Locks paths for the calling actor. The check and the insert run in one write transaction, so
 * two agents can never both hold overlapping exclusive locks. An overlap with another actor's
 * live lock fails with CONFLICT when either side is exclusive; shared over shared is allowed and
 * returned as a warning. The caller's own locks never conflict. Expired locks are released first.
 */
export async function acquireLock(ctx: ServiceContext, input: unknown): Promise<AcquireLockResult> {
  const data = parseInput(AcquireLockInput, input);
  const paths = [...new Set(data.paths)];
  return ctx.store.write(async (w) => {
    if (data.taskId) await mustGet(w, ctx, "task", data.taskId);
    const now = nowIso(ctx);
    const live: Lock[] = [];
    for (const l of await allLocks(w, ctx)) {
      if (isLive(l, now)) live.push(l);
      else await softDelete(w, ctx, l);
    }

    const conflicts: LockOverlap[] = [];
    const warnings: LockOverlap[] = [];
    for (const held of live) {
      if (held.actorId === ctx.actorId) continue;
      const pairs = overlappingPaths(paths, held.paths);
      if (pairs.length === 0) continue;
      const overlap: LockOverlap = {
        lockId: held.id,
        actorId: held.actorId,
        holderName: await actorName(w, held.actorId),
        mode: held.mode,
        leaseUntil: held.leaseUntil,
        paths: pairs,
      };
      const blocking = data.mode === "exclusive" || held.mode === "exclusive";
      (blocking ? conflicts : warnings).push(overlap);
    }
    const first = conflicts[0];
    if (first) {
      const pairs = first.paths.map(([mine, theirs]) => `${mine} overlaps ${theirs}`).join("; ");
      throw new SatiError(
        "CONFLICT",
        `${pairs}, locked (${first.mode}) by ${first.holderName} until ${first.leaseUntil}.`,
        {
          hint: "Pick work outside the locked paths, or ask the holder to release the lock.",
          details: { conflicts },
        },
      );
    }

    const length =
      data.leaseMinutes ?? (await w.getProject())?.settings.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
    const leaseUntil = new Date(ctx.clock.now().getTime() + length * 60_000).toISOString();
    const lock = await insertWithLog(w, ctx, "lock", {
      ...baseFields(ctx, "lock"),
      paths,
      actorId: ctx.actorId,
      taskId: data.taskId ?? null,
      reason: data.reason,
      leaseUntil,
      mode: data.mode,
    });
    return { lock, warnings };
  });
}

/**
 * Releases a lock. Only the holder may release a live lock unless `force` is set; a forced
 * release is logged with the releasing actor, like every write. Expired locks anyone may release.
 */
export async function releaseLock(
  ctx: ServiceContext,
  id: string,
  input: unknown = {},
): Promise<Lock> {
  const { force } = parseInput(ReleaseLockInput, input);
  return ctx.store.write(async (w) => {
    const lock = await mustGet(w, ctx, "lock", id);
    if (lock.actorId !== ctx.actorId && isLive(lock, nowIso(ctx)) && !force) {
      const name = await actorName(w, lock.actorId);
      throw new SatiError("CONFLICT", `Lock ${id} is held by ${name} until ${lock.leaseUntil}.`, {
        hint: "Only the holder releases a lock. Use --force to override; it is logged.",
        details: { holder: lock.actorId, holderName: name, leaseUntil: lock.leaseUntil },
      });
    }
    return softDelete(w, ctx, lock);
  });
}

/**
 * Releases the locks `holder` (default: the caller) holds for a task. Call inside `store.write`.
 * The release is logged with the caller, so a person releasing an agent's claim is recorded.
 */
export async function releaseTaskLocks(
  w: StorageWriter,
  ctx: ServiceContext,
  taskId: string,
  holder: string = ctx.actorId,
): Promise<Lock[]> {
  const mine = (await allLocks(w, ctx)).filter((l) => l.taskId === taskId && l.actorId === holder);
  const out: Lock[] = [];
  for (const l of mine) out.push(await softDelete(w, ctx, l));
  return out;
}

function softDelete(w: StorageWriter, ctx: ServiceContext, lock: Lock): Promise<Lock> {
  return updateWithLog(w, ctx, "lock", lock, { deletedAt: nowIso(ctx) }, { verb: "release" });
}
