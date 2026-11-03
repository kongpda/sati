import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BrainConfigSchema, BrainError, CONFIG_DIR, CONFIG_FILE } from "@brain/core";

export interface DbLocation {
  /** Absolute path of the live SQLite file. */
  path: string;
  mode: "git" | "standalone";
  /** Worktree root (git) or the folder holding `.brain/` (standalone). */
  root: string;
}

export interface LocateOptions {
  /** Home folder for the standalone store; defaults to `os.homedir()`. */
  home?: string;
}

const cache = new Map<string, DbLocation>();

/**
 * Finds the live DB for `cwd`. Inside git it is `<git-common-dir>/brain/brain.db`, shared by
 * every worktree. Outside git it walks up to a standalone `.brain/brain.config.json` and uses
 * `~/.brain/projects/<projectId>.db`. Cached per process.
 */
export function locateDb(cwd: string, opts: LocateOptions = {}): DbLocation {
  const key = `${resolve(cwd)}\0${opts.home ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const found = fromGit(cwd) ?? fromStandalone(cwd, opts.home ?? homedir());
  if (!found) {
    throw new BrainError("NOT_INITIALIZED", "No git repository or standalone project found.", {
      hint: "Run `brain init` in a git repository, or `brain init --mode standalone`.",
    });
  }
  cache.set(key, found);
  return found;
}

/** Where a standalone project's DB lives: `~/.brain/projects/<projectId>.db`. */
export function standaloneDbPath(home: string, projectId: string): string {
  return join(home, ".brain", "projects", `${projectId}.db`);
}

/** For tests only. */
export function clearLocateCache(): void {
  cache.clear();
}

function fromGit(cwd: string): DbLocation | undefined {
  let out: string;
  try {
    out = execFileSync("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
  const [top, common] = out.trim().split(/\r?\n/);
  if (!top || !common) return undefined;
  // `--git-common-dir` may be relative to cwd.
  return { path: join(resolve(cwd, common), "brain", "brain.db"), mode: "git", root: top };
}

function fromStandalone(cwd: string, home: string): DbLocation | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const file = join(dir, CONFIG_DIR, CONFIG_FILE);
    if (existsSync(file)) {
      const parsed = BrainConfigSchema.safeParse(readJson(file));
      if (!parsed.success) {
        throw new BrainError("VALIDATION", `Invalid ${file}.`, {
          details: { issues: parsed.error.issues },
        });
      }
      if (parsed.data.mode !== "standalone") return undefined;
      return { path: standaloneDbPath(home, parsed.data.projectId), mode: "standalone", root: dir };
    }
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new BrainError("VALIDATION", `${file} is not valid JSON.`, {
      details: { cause: String(e) },
    });
  }
}
