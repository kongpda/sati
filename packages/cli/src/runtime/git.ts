import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type BaseConflicts, dirtyFromPorcelain, type RepoFile, type RepoIndex } from "@sati/core";
import type { DbLocation } from "@sati/store-sqlite";
import { defaultBase, samePath } from "../git.js";

/**
 * The branch named in a `HEAD` file, null when HEAD is detached, undefined when the file does
 * not say (missing, or the placeholder a reftable repository keeps there).
 */
export function branchInHead(head: string): string | null | undefined {
  const ref = /^ref: (.+)$/mu.exec(head)?.[1]?.trim();
  if (ref === undefined) return /^[0-9a-f]{40,64}\s*$/u.test(head) ? null : undefined;
  if (!ref.startsWith("refs/heads/") || ref === "refs/heads/.invalid") return undefined;
  return ref.slice("refs/heads/".length);
}

export function currentBranch(location: DbLocation): string | null {
  if (location.mode !== "git") return null;
  // Every command needs the branch for its activity rows. Reading the HEAD file costs
  // microseconds; starting git for it cost several milliseconds each time.
  if (location.gitDir !== undefined) {
    try {
      const named = branchInHead(readFileSync(join(location.gitDir, "HEAD"), "utf8"));
      if (named !== undefined) return named;
    } catch {
      // Ask git below.
    }
  }
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: location.root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out && out !== "HEAD" ? out : null;
  } catch {
    // A repository without commits has no HEAD yet.
    return null;
  }
}

/** Large monorepos list many files; the default 1 MB buffer is far too small. */
const LS_FILES_BUFFER = 512 * 1024 * 1024;

/**
 * The git index as `git ls-files -s` reports it, with staged blob ids. Files that `git status`
 * reports as changed or untracked are hashed from the working tree instead, so an unstaged edit
 * still makes a context entry stale.
 */
export function gitRepoIndex(root: string): RepoIndex {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: LS_FILES_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
  return {
    files: async () => {
      const out: RepoFile[] = [];
      // Where each path sits in `out`: a scan per dirty file was slow with many of both.
      const at = new Map<string, number>();
      // Each record: "<mode> <blob> <stage>\t<path>", NUL-terminated so any path is safe.
      for (const rec of git("ls-files", "-s", "-z").split("\0")) {
        const tab = rec.indexOf("\t");
        if (tab < 0) continue;
        const blob = rec.slice(0, tab).split(" ")[1];
        if (!blob) continue;
        const path = rec.slice(tab + 1);
        // A file in a merge conflict is listed once per stage; the first entry stood before too.
        if (!at.has(path)) at.set(path, out.length);
        out.push({ path, blob });
      }
      let status: string | undefined;
      try {
        status = git("status", "--porcelain=v1", "-z");
      } catch {
        // No worktree (a bare repo, or git status failed). The index hash still stands.
      }
      for (const change of status === undefined ? [] : dirtyFromPorcelain(status)) {
        let blob: string;
        if (change.kind === "deleted") {
          blob = "wt:deleted";
        } else {
          try {
            const abs = join(root, change.path);
            // An untracked folder is listed as one entry (`dir/`); it has no content to hash.
            if (statSync(abs).isDirectory()) continue;
            // The id git gives this content, so a card saved now is still fresh once the same
            // content is committed. (A repo that rewrites files on add, as with autocrlf or LFS,
            // gets another id, and the card reads stale once.)
            const content = readFileSync(abs);
            blob = createHash(out[0]?.blob.length === 64 ? "sha256" : "sha1")
              .update(`blob ${content.length}\0`)
              .update(content)
              .digest("hex");
          } catch {
            continue; // vanished or unreadable: one file must not drop every other dirty hash
          }
        }
        const index = at.get(change.path);
        if (index !== undefined) out[index] = { path: change.path, blob, dirty: true };
        else {
          at.set(change.path, out.length);
          out.push({ path: change.path, blob, dirty: true });
        }
      }
      return out;
    },
    head: async () => {
      try {
        return git("rev-parse", "--verify", "-q", "HEAD").trim() || null;
      } catch {
        return null; // no commits yet
      }
    },
    branchHead: async (branch) => {
      try {
        // `--end-of-options` and the refs/heads/ prefix: a branch name is never an option or a SHA.
        return (
          git(
            "rev-parse",
            "--verify",
            "-q",
            "--end-of-options",
            `refs/heads/${branch}^{commit}`,
          ).trim() || null
        );
      } catch {
        return null; // the branch is gone
      }
    },
    changedBetween: async (from, to) => {
      try {
        // `--no-renames` lists both sides of a rename, so a file moved out of `.sati/` counts.
        const out = git("diff", "--name-only", "-z", "--no-renames", "--end-of-options", from, to);
        return out.split("\0").filter(Boolean);
      } catch {
        return null; // a commit is gone (gc, shallow clone): the caller treats it as moved
      }
    },
    changedFiles: async (worktree) => changedFiles(root, worktree),
    baseConflicts: async () => baseConflicts(root),
  };
}

/** A folder walk stops here, so a project made in a home folder cannot stall every command. */
const FOLDER_FILES_CAP = 20_000;

/**
 * A standalone folder's files, for card staleness without git: each file's size and modified
 * time from `stat`, so a changed file reads as changed and sati still never opens it. Dot
 * folders (`.sati`, `.git`) and `node_modules` are skipped; the walk is sorted, so the same
 * folder always gives the same list.
 */
export function folderIndex(root: string): RepoIndex {
  return {
    files: async () => {
      const out: RepoFile[] = [];
      const walk = (dir: string, prefix: string): void => {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return; // unreadable folder: its files simply have no version
        }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          if (out.length >= FOLDER_FILES_CAP) return;
          if (e.name.startsWith(".") || e.name === "node_modules") continue;
          const path = `${prefix}${e.name}`;
          if (e.isDirectory()) walk(join(dir, e.name), `${path}/`);
          else if (e.isFile()) {
            try {
              const st = statSync(join(dir, e.name));
              out.push({ path, blob: `st:${st.size}:${Math.trunc(st.mtimeMs)}` });
            } catch {
              // vanished between readdir and stat
            }
          }
        }
      };
      walk(root, "");
      return out;
    },
    head: async () => null,
  };
}

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: LS_FILES_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Paths of the linked worktrees of the repo at `root`, from `git worktree list --porcelain -z`. */
export function worktreePaths(root: string): { path: string; branch: string | null }[] {
  const out: { path: string; branch: string | null }[] = [];
  let current: { path: string; branch: string | null } | undefined;
  for (const field of gitIn(root, ["worktree", "list", "--porcelain", "-z"]).split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), branch: null };
      out.push(current);
    } else if (field.startsWith("branch refs/heads/") && current) {
      current.branch = field.slice(18);
    }
  }
  return out;
}

/**
 * What a worktree of this repo changed against the base branch: committed since the merge-base,
 * staged, unstaged and untracked. Null for a path that is not one of the repo's worktrees, so a
 * task record cannot make sati read an arbitrary folder.
 */
function changedFiles(root: string, worktree: string): string[] | null {
  try {
    if (!worktreePaths(root).some((w) => samePath(w.path, worktree))) return null;
    const files = new Set<string>();
    const base = defaultBase(worktree);
    if (base) {
      const committed = gitIn(worktree, [
        "diff",
        "--name-only",
        "-z",
        "--end-of-options",
        `${base}...HEAD`,
      ]);
      for (const f of committed.split("\0")) if (f) files.add(f);
    }
    for (const change of dirtyFromPorcelain(gitIn(worktree, ["status", "--porcelain=v1", "-z"]))) {
      files.add(change.path);
    }
    return [...files];
  } catch {
    return null;
  }
}

/**
 * Files where HEAD would conflict with the base branch, from `git merge-tree --write-tree`
 * (git 2.38+), which merges in memory and touches neither the index nor the worktree.
 * Null when there is no base, git is older, or it fails for another reason.
 *
 * merge-tree writes the merged tree's objects into `.git/objects`, and this runs on every brief
 * and Stop hook, so the answer is kept in `.git/sati/` per pair of commits: git runs again only
 * after the base or HEAD moves.
 */
function baseConflicts(root: string): BaseConflicts | null {
  const base = defaultBase(root);
  if (!base) return null;
  let key: string;
  let cacheFile: string;
  try {
    const shas = gitIn(root, [
      "rev-parse",
      "--end-of-options",
      `${base}^{commit}`,
      "HEAD^{commit}",
    ]);
    // rev-parse echoes `--end-of-options` back; the key is the two commit ids.
    key = shas
      .split("\n")
      .filter((l) => /^[0-9a-f]{40,64}$/.test(l))
      .join("..");
    cacheFile = resolve(
      root,
      gitIn(root, ["rev-parse", "--git-path", "sati/merge-check.json"]).trim(),
    );
  } catch {
    return null;
  }
  try {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as {
      key?: unknown;
      files?: unknown;
    };
    if (cached.key === key && Array.isArray(cached.files)) {
      return { base, files: cached.files.filter((f): f is string => typeof f === "string") };
    }
  } catch {
    // no answer kept yet, or an unreadable one: ask git
  }
  const args = ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", base, "HEAD"];
  let out: string;
  try {
    out = gitIn(root, args);
  } catch (err) {
    // Exit 1 means "merged with conflicts", and the output still lists them.
    const e = err as { status?: number; stdout?: string };
    if (e.status !== 1 || typeof e.stdout !== "string") return null;
    out = e.stdout;
  }
  // Tree id, then each conflicted path once per stage it appears in.
  const [, ...paths] = out.split("\0").filter(Boolean);
  const files = [...new Set(paths)];
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify({ key, files })}\n`);
  } catch {
    // read-only .git: the answer is still right, it is just computed again next time
  }
  return { base, files };
}
