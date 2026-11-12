import { shortHandle } from "../domain/ids.js";
import { normalizeLockPath, pathsOverlap } from "../domain/locks.js";
import { CONFIG_DIR } from "../domain/schemas.js";
import type { BaseConflicts } from "../ports/repo.js";
import { actorName, listAll, nowIso, type ServiceContext } from "./context.js";
import { listLocks } from "./lock.js";

/** One file the caller changed that another agent's worktree also changed, with no lock on it. */
export interface Overlap {
  path: string;
  actorId: string;
  actorName: string;
  /** The other agent's task, so the two can coordinate through it. */
  taskId: string;
  worktree: string;
}

export interface WorktreeWarnings {
  overlaps: Overlap[];
  /** Files that conflict with the base branch; null when git cannot tell or there is no base. */
  conflicts: BaseConflicts | null;
}

/** Bounds the git work and the output: a brief line per overlap is all an agent needs. */
const MAX_WORKTREES = 10;
const MAX_OVERLAPS = 20;

/**
 * Files that say nothing about a collision: sati's own snapshot, which every agent's writes
 * export, and an untracked folder git lists as one `dir/` entry.
 */
const ignored = (path: string) =>
  path === CONFIG_DIR || path.startsWith(`${CONFIG_DIR}/`) || path.endsWith("/");

/**
 * Edits that will collide before they reach a pull request. Another agent's worktree counts when
 * it holds a live claim; a file both changed is reported unless a live lock covers it, because a
 * lock already makes one of them wait. `paths` checks those paths instead of everything the
 * caller changed. Needs git with the worktree methods; returns nothing without them.
 */
export async function worktreeWarnings(
  ctx: ServiceContext,
  opts: { paths?: readonly string[]; conflicts?: boolean } = {},
): Promise<WorktreeWarnings> {
  const repo = ctx.repo;
  const none: WorktreeWarnings = { overlaps: [], conflicts: null };
  if (!repo?.changedFiles) return none;
  const now = nowIso(ctx);
  const { me, others } = await ctx.store.read(async (r) => {
    const me = await r.get("actor", ctx.actorId);
    const tasks = await listAll(r, ctx, "task", { status: ["in_progress", "review", "blocked"] });
    const others = new Map<string, { actorId: string; actorName: string; taskId: string }>();
    for (const t of tasks) {
      const c = t.claim;
      if (!c || c.actorId === ctx.actorId || c.leaseUntil <= now) continue;
      const worktree = t.worktree ?? (await r.get("actor", c.actorId))?.worktree ?? null;
      if (!worktree || others.has(worktree)) continue;
      others.set(worktree, {
        actorId: c.actorId,
        actorName: await actorName(r, c.actorId),
        taskId: t.id,
      });
    }
    return { me, others };
  });
  const conflicts =
    opts.conflicts === false || !repo.baseConflicts ? null : await repo.baseConflicts();
  const own = me?.worktree ?? null;
  others.delete(own ?? "");
  if (others.size === 0) return { overlaps: [], conflicts };
  const mine = opts.paths
    ? opts.paths.flatMap((p) => normalizeLockPath(p) ?? [])
    : own
      ? ((await repo.changedFiles(own)) ?? [])
      : [];
  if (mine.length === 0) return { overlaps: [], conflicts };
  const mineSet = new Set(mine.filter((p) => !ignored(p)));
  // Given paths can be globs, as lock paths are; changed files are plain paths.
  const touches = (path: string) =>
    mineSet.has(path) || (opts.paths !== undefined && mine.some((p) => pathsOverlap(p, path)));
  const locks = await listLocks(ctx);
  const locked = (path: string) => locks.some((l) => l.paths.some((g) => pathsOverlap(g, path)));
  const overlaps: Overlap[] = [];
  for (const [worktree, other] of [...others].slice(0, MAX_WORKTREES)) {
    const theirs = await repo.changedFiles(worktree);
    for (const path of theirs ?? []) {
      if (ignored(path) || !touches(path) || locked(path)) continue;
      overlaps.push({ path, worktree, ...other });
      if (overlaps.length >= MAX_OVERLAPS) return { overlaps, conflicts };
    }
  }
  return { overlaps, conflicts };
}

/** The warnings as short lines, for the brief and the Stop hook. */
export function warningLines(w: WorktreeWarnings): string[] {
  const lines = w.overlaps.map(
    (o) =>
      `${o.path} is also changed by ${o.actorName} (task ${shortHandle(o.taskId)}); no lock covers it.`,
  );
  if (w.conflicts && w.conflicts.files.length > 0) {
    const files = w.conflicts.files;
    const shown = files.slice(0, 5).join(", ");
    const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
    lines.push(`Your branch conflicts with ${w.conflicts.base} in ${shown}${more}.`);
  }
  return lines;
}
