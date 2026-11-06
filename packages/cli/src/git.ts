import { execFileSync } from "node:child_process";
import { type ChangeKind, SatiError } from "@sati/core";

export interface Change {
  path: string;
  kind: ChangeKind;
  removedLines?: number;
  baseLines?: number;
  from?: string;
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

interface NamedChange {
  path: string;
  kind: ChangeKind;
  from?: string;
}

/** `git diff` args shared by the index and a commit range. `-M` keeps a rename as one change. */
function diffChanges(root: string, diffArgs: string[]): Change[] {
  const status = git(root, [...diffArgs, "--name-status"])
    .toString("utf8")
    .split("\0");
  const kinds: NamedChange[] = [];
  for (let i = 0; i < status.length; i++) {
    const code = status[i];
    if (!code) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      const from = status[i + 1];
      const path = status[i + 2];
      i += 2;
      if (!from || !path) continue;
      kinds.push(code.startsWith("R") ? { path, kind: "renamed", from } : { path, kind: "added" });
      continue;
    }
    const path = status[i + 1];
    i += 1;
    if (!path) continue;
    kinds.push({
      path,
      kind: code === "A" ? "added" : code === "D" ? "deleted" : "modified",
    });
  }

  // `--numstat -z` prints "added<TAB>removed<TAB>path\0". A rename is
  // "added<TAB>removed<TAB>\0old\0new\0". Binary files show "-" counts.
  const removed = new Map<string, number>();
  const stat = git(root, [...diffArgs, "--numstat"])
    .toString("utf8")
    .split("\0");
  for (let i = 0; i < stat.length; i++) {
    const entry = stat[i];
    if (!entry) continue;
    const [added, del, path] = entry.split("\t");
    if (del === undefined || del === "-") continue;
    if (path === "" && stat[i + 1] && stat[i + 2] !== undefined) {
      removed.set(stat[i + 2] as string, Number(del));
      i += 2;
      continue;
    }
    if (path) removed.set(path, Number(del));
    void added;
  }
  const modified = kinds
    .filter((c) => c.kind === "modified" && removed.has(c.path))
    .map((c) => c.path);
  const baseLines = hasHead(root) ? headLineCounts(root, modified) : new Map<string, number>();

  return kinds.map((change) => {
    const del = removed.get(change.path);
    if (del === undefined) return change;
    const lines = change.kind === "deleted" ? del : baseLines.get(change.path);
    return {
      ...change,
      removedLines: del,
      ...(lines === undefined ? {} : { baseLines: lines }),
    };
  });
}

/** The staged changes, with line counts. A rename stays one change, with its old path. */
export function stagedChanges(root: string): Change[] {
  return diffChanges(root, ["diff", "--cached", "-M", "-z"]);
}

/**
 * Changes between two revisions, as in `origin/main...HEAD`. The range is a git revision
 * expression, not a shell command.
 */
export function rangeChanges(root: string, range: string): Change[] {
  if (!/^[\w./@{}~^-]+(\.{2,3}[\w./@{}~^-]+)?$/u.test(range)) {
    throw new SatiError("USAGE", `\`${range}\` is not a git revision range.`, {
      hint: "Example: origin/main...HEAD",
    });
  }
  return diffChanges(root, ["diff", "-M", "-z", range]);
}
