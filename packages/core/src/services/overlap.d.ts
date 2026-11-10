import type { BaseConflicts } from "../ports/repo.js";
import { type ServiceContext } from "./context.js";
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
/**
 * Edits that will collide before they reach a pull request. Another agent's worktree counts when
 * it holds a live claim; a file both changed is reported unless a live lock covers it, because a
 * lock already makes one of them wait. `paths` checks those paths instead of everything the
 * caller changed. Needs git with the worktree methods; returns nothing without them.
 */
export declare function worktreeWarnings(ctx: ServiceContext, opts?: {
    paths?: readonly string[];
    conflicts?: boolean;
}): Promise<WorktreeWarnings>;
/** The warnings as short lines, for the brief and the Stop hook. */
export declare function warningLines(w: WorktreeWarnings): string[];
