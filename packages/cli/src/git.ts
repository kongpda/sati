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

function hasRev(root: string, rev: string): boolean {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Line counts of `<base>:<path>` blobs, read in one `git cat-file --batch` call. */
function baseLineCounts(root: string, base: string, paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  // The batch input is line-based, so a path containing a newline cannot be asked for.
  const asked = paths.filter((p) => !p.includes("\n"));
  if (asked.length === 0) return counts;
  const out = git(root, ["cat-file", "--batch"], asked.map((p) => `${base}:${p}\n`).join(""));
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

/**
 * `git diff` shared by the index and a commit range. `-M` keeps a rename as one change. `base` is
 * the revision the removal ratio is measured against: HEAD for the index, the range's left side
 * (its merge-base for `a...b`) for a range. `revs` follow `--end-of-options`, so a revision
 * can never be read as a git option.
 */
function diffChanges(
  root: string,
  base: string,
  diffArgs: string[],
  revs: string[] = [],
): Change[] {
  const tail = revs.length ? ["--end-of-options", ...revs] : [];
  const status = git(root, [...diffArgs, "--name-status", ...tail])
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
  const added = new Map<string, number>();
  const stat = git(root, [...diffArgs, "--numstat", ...tail])
    .toString("utf8")
    .split("\0");
  for (let i = 0; i < stat.length; i++) {
    const entry = stat[i];
    if (!entry) continue;
    const [add, del, path] = entry.split("\t");
    if (del === undefined || del === "-") continue;
    let name = path;
    if (path === "" && stat[i + 1] && stat[i + 2] !== undefined) {
      name = stat[i + 2] as string;
      i += 2;
    }
    if (!name) continue;
    removed.set(name, Number(del));
    added.set(name, Number(add));
  }
  const modified = kinds
    .filter((c) => c.kind === "modified" && removed.has(c.path))
    .map((c) => c.path);
  const baseLines = hasRev(root, base)
    ? baseLineCounts(root, base, modified)
    : new Map<string, number>();

  return kinds.map((change) => {
    const del = removed.get(change.path);
    if (del === undefined) return change;
    const lines = change.kind === "deleted" ? del : baseLines.get(change.path);
    return {
      ...change,
      removedLines: del,
      addedLines: added.get(change.path) ?? 0,
      ...(lines === undefined ? {} : { baseLines: lines }),
    };
  });
}

/** The staged changes, with line counts. A rename stays one change, with its old path. */
export function stagedChanges(root: string): Change[] {
  return diffChanges(root, "HEAD", ["diff", "--cached", "-M", "-z"]);
}

const REV = String.raw`(?!-)[\w./@{}~^-]+?`;
const RANGE = new RegExp(`^(${REV})(?:(\\.{2,3})(${REV})?)?$`, "u");

/**
 * The revision a range's removals are measured against: the left side of `a..b`, the merge-base
 * for `a...b`, or the revision itself.
 */
function rangeBase(root: string, range: string): string {
  const m = RANGE.exec(range);
  const left = m?.[1] ?? range;
  if (m?.[2] !== "...") return left;
  const right = m[3] ?? "HEAD";
  try {
    return git(root, ["merge-base", "--end-of-options", left, right]).toString("utf8").trim();
  } catch {
    return left;
  }
}

/**
 * Changes between two revisions, as in `origin/main...HEAD`. The range is a git revision
 * expression, not a shell command, and may not start with `-`.
 */
export function rangeChanges(root: string, range: string): Change[] {
  if (!RANGE.test(range)) {
    throw new SatiError("USAGE", `\`${range}\` is not a git revision range.`, {
      hint: "Example: origin/main...HEAD",
    });
  }
  try {
    return diffChanges(root, rangeBase(root, range), ["diff", "-M", "-z"], [range]);
  } catch (err) {
    if (err instanceof SatiError) throw err;
    throw new SatiError("USAGE", `Could not diff ${range}.`, {
      hint: "Pass a range git can resolve, such as main...HEAD.",
    });
  }
}

/**
 * The branch a push or review is compared with: what `origin/HEAD` points at, else `origin/main`.
 * Undefined when neither exists.
 */
export function defaultBase(root: string): string | undefined {
  for (const args of [
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ["rev-parse", "--verify", "--quiet", "--abbrev-ref", "origin/main"],
  ]) {
    try {
      const out = git(root, args).toString("utf8").trim();
      if (out && hasRev(root, out)) return out;
    } catch {
      // try the next
    }
  }
  return undefined;
}
