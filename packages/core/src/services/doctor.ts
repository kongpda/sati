import { nowIso, type ServiceContext } from "./context.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Stale claims, locks whose lease has ended, and tasks flagged needsReview. */
export async function doctorChecks(ctx: ServiceContext): Promise<DoctorCheck[]> {
  const now = nowIso(ctx);
  const data = await ctx.store.read(async (r) => ({
    tasks: await r.list("task", ctx.projectId, {
      status: ["in_progress", "review", "blocked"],
      limit: 500,
    }),
    locks: await r.list("lock", ctx.projectId, { limit: 500 }),
    review: await r.list("task", ctx.projectId, { limit: 500 }),
  }));
  const stale = data.tasks.filter((t) => t.claim && t.claim.leaseUntil <= now);
  const expiredLocks = data.locks.filter((l) => l.leaseUntil <= now);
  const flagged = data.review.filter((t) => t.needsReview === true);
  return [
    {
      name: "claims",
      ok: stale.length === 0,
      detail: stale.length === 0 ? "No expired claims." : `${stale.length} expired claim(s).`,
    },
    {
      name: "locks",
      ok: expiredLocks.length === 0,
      detail:
        expiredLocks.length === 0 ? "No expired locks." : `${expiredLocks.length} expired lock(s).`,
    },
    {
      name: "needsReview",
      ok: flagged.length === 0,
      detail:
        flagged.length === 0
          ? "Nothing is flagged needsReview."
          : `${flagged.length} record(s) still need review.`,
    },
  ];
}
