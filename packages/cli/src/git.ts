import { execFileSync } from "node:child_process";
import type { ChangeKind } from "@sati/core";

export interface Change {
  path: string;
  kind: ChangeKind;
  removedLines?: number;
  baseLines?: number;
}

function git(root: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd: root,
    input,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function hasHead(root: string): boolean {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/** Line counts of `HEAD:<path>` blobs, read in one `git cat-file --batch` call. */
function headLineCounts(root: string, paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  // The batch input is line-based, so a path containing a newline cannot be asked for.
  const asked = paths.filter((p) => !p.includes("\n"));
  if (asked.length === 0) return counts;
  const out = git(root, ["cat-file", "--batch"], asked.map((p) => `HEAD:${p}\n`).join(""));
  let pos = 0;
  for (const path of asked) {
    const eol = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, eol).toString("utf8");
    pos = eol + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    const body = out.subarray(pos, pos + size);
    let lines = 0;
    for (const byte of body) if (byte === 0x0a) lines++;
    if (size > 0 && body[size - 1] !== 0x0a) lines++;
    counts.set(path, lines);
    pos += size + 1;
  }
  return counts;
}

/**
 * The staged changes, with line counts. Renames show as a delete plus an add, which errs towards
 * blocking; rename detection is a separate PLAN item.
 */
export function stagedChanges(root: string): Change[] {
  const base = ["diff", "--cached", "--no-renames", "-z"];
  const status = git(root, [...base, "--name-status"])
    .toString("utf8")
    .split("\0");
  const kinds = new Map<string, ChangeKind>();
  for (let i = 0; i + 1 < status.length; i += 2) {
    const code = status[i] as string;
    kinds.set(
      status[i + 1] as string,
      code === "A" ? "added" : code === "D" ? "deleted" : "modified",
    );
  }
  // `--numstat -z` prints "added<TAB>removed<TAB>path\0"; binary files show "-" counts.
  const removed = new Map<string, number>();
  for (const entry of git(root, [...base, "--numstat"])
    .toString("utf8")
    .split("\0")) {
    const [, del, path] = entry.split("\t");
    if (path !== undefined && del !== "-") removed.set(path, Number(del));
  }
  const modified = [...kinds]
    .filter(([p, k]) => k === "modified" && removed.has(p))
    .map(([p]) => p);
  const baseLines = hasHead(root) ? headLineCounts(root, modified) : new Map<string, number>();

  return [...kinds].map(([path, kind]) => {
    const change: Change = { path, kind };
    const del = removed.get(path);
    if (del === undefined) return change;
    change.removedLines = del;
    // A deleted file's removed lines are all of its lines.
    const lines = kind === "deleted" ? del : baseLines.get(path);
    if (lines !== undefined) change.baseLines = lines;
    return change;
  });
}
