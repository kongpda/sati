import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLI_NAME, CONFIG_DIR, CONFIG_FILE, SatiConfigSchema, SatiError } from "@sati/core";

export interface DbLocation {
  /** Absolute path of the live SQLite file. */
  path: string;
  mode: "git" | "standalone";
  /** Worktree root (git) or the folder holding `.sati/` (standalone). */
  root: string;
}

export interface LocateOptions {
  /** Home folder for the standalone store; defaults to `os.homedir()`. */
  home?: string;
}

const cache = new Map<string, DbLocation>();

/**
 * Finds the live DB for `cwd`. Inside git it is `<git-common-dir>/sati/sati.db`, shared by
 * every worktree. Outside git it walks up to a standalone `.sati/sati.config.json` and uses
 * `~/.sati/projects/<projectId>.db`. Cached per process.
 */
export function locateDb(cwd: string, opts: LocateOptions = {}): DbLocation {
  const key = `${resolve(cwd)}\0${opts.home ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let gitError: unknown;
  let found: DbLocation | undefined;
  try {
    found = fromGit(cwd);
  } catch (err) {
    gitError = err;
  }
  // A standalone project says so in its own config, so a broken `.git` above it does not block it.
  found ??= fromStandalone(cwd, opts.home ?? homedir());
  if (!found && gitError) throw gitError;
  if (!found) {
    throw new SatiError("NOT_INITIALIZED", "No git repository or standalone project found.", {
      hint: "Run `sati init` in a git repository, or `sati init --mode standalone`.",
    });
  }
  cache.set(key, found);
  return found;
}

/** Where a standalone project's DB lives: `~/.sati/projects/<projectId>.db`. */
export function standaloneDbPath(home: string, projectId: string): string {
  return join(home, ".sati", "projects", `${projectId}.db`);
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
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Not a repo is fine. A `.git` here that git cannot read means git is missing or broken;
    // treating the folder as "no project" would hide that and skip the git hooks.
    const gitDir = findGitDir(cwd);
    if (!gitDir) return undefined;
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    const cause = stderr || (err instanceof Error ? err.message : String(err));
    // git says "this operation must be run in a work tree" inside `.git` itself.
    const hint = /work tree/iu.test(stderr)
      ? `Run ${CLI_NAME} from the working tree, not from inside \`.git\`.`
      : "Check that git is installed and on PATH, and that `git status` works here.";
    throw new SatiError("INTERNAL", `Found ${gitDir}, but \`git rev-parse\` failed.`, {
      hint,
      details: { gitDir, cause },
    });
  }
  const [top, common] = out.trim().split(/\r?\n/);
  if (!top || !common) return undefined;
  // `--git-common-dir` may be relative to cwd. git prints `/` on Windows; resolve() gives native paths.
  return { path: join(resolve(cwd, common), "sati", "sati.db"), mode: "git", root: resolve(top) };
}

/** The nearest `.git` folder or file at or above `cwd`, if any. */
function findGitDir(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

function fromStandalone(cwd: string, home: string): DbLocation | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const file = join(dir, CONFIG_DIR, CONFIG_FILE);
    if (existsSync(file)) {
      const parsed = SatiConfigSchema.safeParse(readJson(file));
      if (!parsed.success) {
        throw new SatiError("VALIDATION", `Invalid ${file}.`, {
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
    throw new SatiError("VALIDATION", `${file} is not valid JSON.`, {
      details: { cause: String(e) },
    });
  }
}
