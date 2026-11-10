/** One tracked file as git's index sees it (`git ls-files -s`): no file contents are read. */
export interface RepoFile {
    path: string;
    /** The blob hash git stores for the staged content. */
    blob: string;
}
/** Files of the current branch that conflict with the base branch it will merge into. */
export interface BaseConflicts {
    /** The branch compared with, such as `origin/main`. */
    base: string;
    files: string[];
}
/**
 * Read-only view of the git repository, supplied by the CLI. Absent outside a git repo.
 * The optional methods read refs and other worktrees; services treat a missing one as "unknown".
 */
export interface RepoIndex {
    files(): Promise<RepoFile[]>;
    /** The commit HEAD points at, or null in a repo without commits. */
    head(): Promise<string | null>;
    /** The commit a local branch points at, or null when the branch does not exist. */
    branchHead?(branch: string): Promise<string | null>;
    /** Repo-relative files that differ between two commits; null when git cannot tell. */
    changedBetween?(from: string, to: string): Promise<string[] | null>;
    /**
     * Repo-relative files a worktree changed: committed since its merge-base with the base branch,
     * staged, unstaged and untracked. Null when the path is not a worktree of this repo.
     */
    changedFiles?(worktree: string): Promise<string[] | null>;
    /** Conflicts between HEAD and the base branch; null when there is no base or git cannot tell. */
    baseConflicts?(): Promise<BaseConflicts | null>;
}
