import { SatiError } from "../domain/errors.js";
import { ID_PREFIXES, shortHandle } from "../domain/ids.js";
import { findDependencyCycle } from "../domain/rules.js";
import type { ContextEntry, Task } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import type { StorageReader } from "../ports/storage.js";
import { listAll, mustGet, nowIso, type ServiceContext, updateWithLog } from "./context.js";
import { resolveId } from "./query.js";
import { claimHealth } from "./task.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Links a write would refuse but a git merge can produce: a task in a dependency cycle (it and
 * the others never become ready), or one pointing at a feature, milestone, parent or dependency
 * that is not there. `ids` limits the check to those tasks (an import checks what it brought in).
 * Deleted dependencies are fine: they no longer block.
 */
export async function linkProblems(
  r: StorageReader,
  ctx: ServiceContext,
  ids?: readonly string[],
  /** Every task, deleted ones too, when the caller has read them already. */
  all?: readonly Task[],
): Promise<string[]> {
  if (!all && !ids) all = await listAll(r, ctx, "task", { includeDeleted: true });
  const tasks = new Map((all ?? []).map((t) => [t.id, t]));
  if (!all && ids) {
    // Read only the checked tasks, their parents and every task their dependencies reach:
    // a cycle through a checked task runs along its dependencies, so nothing else matters.
    const seen = new Set<string>();
    const queue = [...ids];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const t = await r.get("task", id);
      if (!t) continue;
      tasks.set(id, t);
      queue.push(...t.dependsOn);
      if (t.parentId && ids.includes(id)) queue.push(t.parentId);
    }
  }
  const known = new Map<string, boolean>();
  const live = async (entity: "feature" | "milestone", id: string) => {
    const key = `${entity}:${id}`;
    let ok = known.get(key);
    if (ok === undefined) {
      const rec = await r.get(entity, id);
      ok = rec !== undefined && rec.deletedAt === null;
      known.set(key, ok);
    }
    return ok;
  };
  const out: string[] = [];
  const cycles = new Set<string>();
  const check = ids ? ids.flatMap((id) => tasks.get(id) ?? []) : (all ?? []);
  for (const t of check.filter((x: Task) => x.deletedAt === null)) {
    const h = shortHandle(t.id);
    if (t.featureId && !(await live("feature", t.featureId))) {
      out.push(`${h} links to feature ${shortHandle(t.featureId)}, which is missing or deleted.`);
    }
    if (t.milestoneId && !(await live("milestone", t.milestoneId))) {
      out.push(`${h} links to milestone ${shortHandle(t.milestoneId)}, which is missing.`);
    }
    if (t.parentId && !tasks.get(t.parentId)) {
      out.push(`${h} has parent ${shortHandle(t.parentId)}, which is missing.`);
    }
    for (const dep of t.dependsOn) {
      if (!tasks.has(dep)) out.push(`${h} waits for ${shortHandle(dep)}, which is missing.`);
    }
    // Only waiting tasks block: a cycle through done, cancelled or deleted work is harmless.
    const blocks = (id: string) => {
      const dep = tasks.get(id);
      const waits = dep && dep.deletedAt === null && !["done", "cancelled"].includes(dep.status);
      return waits ? dep.dependsOn : [];
    };
    const cycle = blocks(t.id).length ? findDependencyCycle(t.id, t.dependsOn, blocks) : undefined;
    // Each cycle once, whichever of its tasks found it.
    const key = cycle ? [...new Set(cycle)].sort().join(" ") : "";
    if (cycle && !cycles.has(key)) {
      cycles.add(key);
      out.push(`Dependency cycle: ${cycle.map(shortHandle).join(" -> ")}.`);
    }
  }
  return out;
}

/** Every kind of record the merge driver can flag `needsReview`. */
const REVIEWABLE = ["task", "feature", "milestone", "note", "decision", "context"] as const;

/**
 * Clears `needsReview` on any record, after a person has looked at the merge. Tasks, features
 * and notes also take `reviewed` on their own update; milestones, decisions and cards have only
 * this.
 */
export async function markReviewed(ctx: ServiceContext, ref: string): Promise<{ id: string }> {
  const prefix = ref.trim().split("_")[0];
  const entity = REVIEWABLE.find((e) => ID_PREFIXES[e] === prefix);
  if (!entity) {
    throw new SatiError("VALIDATION", `"${ref}" is not a record that can need review.`, {
      hint: `Give the id of a ${REVIEWABLE.join(", ")}.`,
    });
  }
  const id = await resolveId(ctx, entity, ref);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, entity, id);
    const after = await updateWithLog(w, ctx, entity, before, {}, { clear: ["needsReview"] });
    return { id: after.id };
  });
}

/**
 * Stale claims, claims whose agent has stopped, expired locks, tasks flagged needsReview, broken
 * links, and the private notes and cards that never leave this machine.
 */
export async function doctorChecks(ctx: ServiceContext): Promise<DoctorCheck[]> {
  const now = nowIso(ctx);
  const data = await ctx.store.read(async (r) => {
    // One read of every task: the claims, review and link checks each used to read them again.
    const all = await listAll(r, ctx, "task", { includeDeleted: true });
    const live = all.filter((t) => t.deletedAt === null);
    const notes = await listAll(r, ctx, "note");
    const cards = await listAll(r, ctx, "context");
    // The merge driver can flag any synced record, not only a task.
    const synced: { id: string; needsReview?: true | undefined }[] = [
      ...live,
      ...(await listAll(r, ctx, "feature")),
      ...(await listAll(r, ctx, "milestone")),
      ...(await listAll(r, ctx, "decision")),
      ...notes,
      ...cards,
    ];
    return {
      tasks: live.filter((t) => ["in_progress", "review", "blocked"].includes(t.status)),
      locks: await listAll(r, ctx, "lock"),
      review: synced.filter((rec) => rec.needsReview === true).map((rec) => shortHandle(rec.id)),
      links: await linkProblems(r, ctx, undefined, all),
      mode: (await r.getProject())?.mode ?? "git",
      private: [
        ...notes.filter((n) => n.private).map((n) => `note "${n.title}"`),
        ...cards.filter((c) => c.private).map((c) => `card ${c.path}`),
      ],
    };
  });
  const stale = data.tasks.filter((t) => t.claim && t.claim.leaseUntil <= now);
  const health = claimHealth(ctx, data.tasks);
  const expiredLocks = data.locks.filter((l) => l.leaseUntil <= now);
  const flagged = data.review;
  const claimProblems = [
    stale.length > 0 ? `${stale.length} expired claim(s)` : "",
    health.gone.length > 0
      ? `${health.gone.length} claim(s) whose agent has stopped (${health.gone.map((t) => shortHandle(t.id)).join(", ")})`
      : "",
  ].filter(Boolean);
  const checks: DoctorCheck[] = [
    {
      name: "claims",
      ok: claimProblems.length === 0,
      detail:
        claimProblems.length === 0
          ? "No expired claims and no stopped agents."
          : `${claimProblems.join("; ")}. The next brief releases them.`,
    },
  ];
  if (health.tripped) {
    // Informational: nothing is released, so nothing is broken; the leases still run out.
    checks.push({
      name: "holders",
      ok: true,
      detail: `Most claim holders (${health.probed}) look stopped at once, so none were treated as stopped. This usually means the process check cannot see them (a container or another PID namespace); their leases still expire.`,
    });
  }
  checks.push(
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
          : `${flagged.length} record(s) still need review: ${flagged.slice(0, 8).join(", ")}${flagged.length > 8 ? ", …" : ""}. A merge changed them on both sides. Look at each, then run \`${CLI_NAME} doctor --reviewed <id>\`.`,
    },
    {
      name: "links",
      ok: data.links.length === 0,
      detail:
        data.links.length === 0
          ? "Every task's links and dependencies are sound."
          : `${data.links.slice(0, 5).join(" ")}${data.links.length > 5 ? ` …and ${data.links.length - 5} more.` : ""} Fix with \`task update --depends-on\`, \`--feature\` or \`--milestone\`.`,
    },
    // Information, not a problem: what stays on this machine and never reaches .sati/ or git.
    {
      name: "private",
      ok: true,
      detail:
        data.mode !== "git"
          ? `Nothing is shared: in ${data.mode} mode every record stays on this machine.`
          : data.private.length === 0
            ? "Nothing is private; every note and card is shared through .sati/."
            : `${data.private.length} private item(s) stay on this machine only: ${data.private.slice(0, 5).join(", ")}${data.private.length > 5 ? ` …and ${data.private.length - 5} more` : ""}.`,
    },
  );
  return checks;
}

/** A finished task this old is reported as bloat. */
export const LEAN_DONE_DAYS = 90;

export interface LeanReport {
  /** Done and cancelled tasks not touched for `LEAN_DONE_DAYS`. */
  oldDone: number;
  /** Every card. The caller knows which files still exist; core does no I/O. */
  cards: ContextEntry[];
}

/** What may be bloat: old finished tasks, and the cards for the caller to check against disk. */
export async function leanReport(ctx: ServiceContext): Promise<LeanReport> {
  const cutoff = new Date(ctx.clock.now().getTime() - LEAN_DONE_DAYS * 86_400_000).toISOString();
  return ctx.store.read(async (r) => {
    const finished = await listAll(r, ctx, "task", { status: ["done", "cancelled"] });
    return {
      oldDone: finished.filter((t) => t.updatedAt < cutoff).length,
      cards: await listAll(r, ctx, "context"),
    };
  });
}

/**
 * Removes expired locks and the given cards (those whose file is gone) in one transaction. Each
 * removal is logged like any other write. Finished tasks are never removed: a deleted record
 * stays in `.sati/` as a tombstone, so deleting them would lose history and free nothing.
 */
export async function leanCleanup(
  ctx: ServiceContext,
  cardIds: readonly string[],
): Promise<{ locks: number; cards: string[] }> {
  return ctx.store.write(async (w) => {
    const now = nowIso(ctx);
    const expired = (await listAll(w, ctx, "lock")).filter((l) => l.leaseUntil <= now);
    for (const l of expired) {
      await updateWithLog(w, ctx, "lock", l, { deletedAt: now }, { verb: "release" });
    }
    const cards: string[] = [];
    for (const id of cardIds) {
      const card = await mustGet(w, ctx, "context", id);
      await updateWithLog(w, ctx, "context", card, { deletedAt: now }, { verb: "delete" });
      cards.push(card.path);
    }
    return { locks: expired.length, cards };
  });
}

/** A linked git worktree as the CLI reads it. */
export interface LinkedWorktree {
  path: string;
  /** Its branch, or null when HEAD is detached. */
  branch: string | null;
  /** No staged, unstaged or untracked changes. */
  clean: boolean;
  /** Its HEAD is already in the base branch. */
  merged: boolean;
}

/** A worktree that can be removed, and the command that removes it. */
export interface RemovableWorktree {
  path: string;
  branch: string | null;
  command: string;
}

/**
 * Linked worktrees that are safe to remove: clean, merged into the base branch, and not the place
 * of any open task or live claim. This only lists them; it never removes a worktree, and one with
 * uncommitted work is never listed.
 */
export async function removableWorktrees(
  ctx: ServiceContext,
  worktrees: readonly LinkedWorktree[],
): Promise<RemovableWorktree[]> {
  const now = nowIso(ctx);
  const { tasks, actors } = await ctx.store.read(async (r) => ({
    tasks: await listAll(r, ctx, "task", {
      status: ["backlog", "todo", "in_progress", "review", "blocked"],
    }),
    actors: await listAll(r, ctx, "actor"),
  }));
  const busy = new Set<string>();
  for (const t of tasks) {
    if (t.worktree) busy.add(`wt:${t.worktree}`);
    if (t.branch) busy.add(`br:${t.branch}`);
    const holder = t.claim && t.claim.leaseUntil > now ? t.claim.actorId : undefined;
    const place = holder ? actors.find((a) => a.id === holder)?.worktree : undefined;
    if (place) busy.add(`wt:${place}`);
  }
  return worktrees
    .filter(
      (w) =>
        w.clean &&
        w.merged &&
        !busy.has(`wt:${w.path}`) &&
        (w.branch === null || !busy.has(`br:${w.branch}`)),
    )
    .map((w) => ({
      path: w.path,
      branch: w.branch,
      // Single quotes, so a path with `$` or a backtick cannot run anything when pasted.
      command: `git worktree remove '${w.path.replaceAll("'", "'\\''")}'`,
    }));
}
