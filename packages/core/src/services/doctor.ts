import { shortHandle } from "../domain/ids.js";
import { findDependencyCycle } from "../domain/rules.js";
import type { Task } from "../domain/schemas.js";
import type { StorageReader } from "../ports/storage.js";
import { listAll, nowIso, type ServiceContext } from "./context.js";
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
): Promise<string[]> {
  const all = await listAll(r, ctx, "task", { includeDeleted: true });
  const tasks = new Map(all.map((t) => [t.id, t]));
  const live = async (entity: "feature" | "milestone", id: string) => {
    const rec = await r.get(entity, id);
    return rec !== undefined && rec.deletedAt === null;
  };
  const out: string[] = [];
  const cycles = new Set<string>();
  const check = ids ? ids.flatMap((id) => tasks.get(id) ?? []) : all;
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

/**
 * Stale claims, claims whose agent has stopped, expired locks, tasks flagged needsReview, broken
 * links, and the private notes and cards that never leave this machine.
 */
export async function doctorChecks(ctx: ServiceContext): Promise<DoctorCheck[]> {
  const now = nowIso(ctx);
  const data = await ctx.store.read(async (r) => ({
    tasks: await r.list("task", ctx.projectId, {
      status: ["in_progress", "review", "blocked"],
      limit: 500,
    }),
    locks: await r.list("lock", ctx.projectId, { limit: 500 }),
    review: (await listAll(r, ctx, "task")).filter((t) => t.needsReview === true),
    links: await linkProblems(r, ctx),
    private: [
      ...(await listAll(r, ctx, "note")).filter((n) => n.private).map((n) => `note "${n.title}"`),
      ...(await listAll(r, ctx, "context")).filter((c) => c.private).map((c) => `card ${c.path}`),
    ],
  }));
  const stale = data.tasks.filter((t) => t.claim && t.claim.leaseUntil <= now);
  const health = claimHealth(ctx, data.tasks);
  const expiredLocks = data.locks.filter((l) => l.leaseUntil <= now);
  const flagged = data.review;
  const claimProblems = [
    stale.length > 0 ? `${stale.length} expired claim(s)` : "",
    health.gone.length > 0
      ? `${health.gone.length} claim(s) whose agent has stopped (${health.gone.map((t) => t.id).join(", ")})`
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
          : `${flagged.length} record(s) still need review.`,
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
        data.private.length === 0
          ? "Nothing is private; every note and card is shared through .sati/."
          : `${data.private.length} private item(s) stay on this machine only: ${data.private.slice(0, 5).join(", ")}${data.private.length > 5 ? ` …and ${data.private.length - 5} more` : ""}.`,
    },
  );
  return checks;
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
    tasks: await r.list("task", ctx.projectId, {
      status: ["backlog", "todo", "in_progress", "review", "blocked"],
      limit: 500,
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
