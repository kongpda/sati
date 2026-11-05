export interface DirtyPath {
  path: string;
  kind: "modified" | "deleted" | "untracked";
}

/**
 * Reads `git status --porcelain=v1 -z`. A worktree change (modified, deleted, untracked) is
 * returned so the context hash is not limited to the index. Renames use the new path.
 */
export function dirtyFromPorcelain(raw: string): DirtyPath[] {
  const parts = raw.split("\0").filter((part) => part.length > 0);
  const out: DirtyPath[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0] ?? " ";
    const y = rec[1] ?? " ";
    let path = rec.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      path = parts[++i] ?? path;
      out.push({ path, kind: "modified" });
      continue;
    }
    if (x === "?" && y === "?") out.push({ path, kind: "untracked" });
    else if (y === "D") out.push({ path, kind: "deleted" });
    else if (y === "M" || y === "T") out.push({ path, kind: "modified" });
  }
  return out;
}
