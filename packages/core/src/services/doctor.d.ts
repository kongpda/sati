import type { StorageReader } from "../ports/storage.js";
import { type ServiceContext } from "./context.js";
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
export declare function linkProblems(r: StorageReader, ctx: ServiceContext, ids?: readonly string[]): Promise<string[]>;
/**
 * Stale claims, claims whose agent has stopped, expired locks, tasks flagged needsReview, broken
 * links, and the private notes and cards that never leave this machine.
 */
export declare function doctorChecks(ctx: ServiceContext): Promise<DoctorCheck[]>;
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
export declare function removableWorktrees(ctx: ServiceContext, worktrees: readonly LinkedWorktree[]): Promise<RemovableWorktree[]>;
