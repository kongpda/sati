export interface DirtyPath {
    path: string;
    kind: "modified" | "deleted" | "untracked";
}
/**
 * Reads `git status --porcelain=v1 -z`. A worktree change (modified, deleted, untracked) is
 * returned so the context hash is not limited to the index. Renames use the new path.
 */
export declare function dirtyFromPorcelain(raw: string): DirtyPath[];
