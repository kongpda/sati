import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  actorIdentity,
  CONFIG_DIR,
  createIdFactory,
  ensureActor,
  getProject,
  isSatiError,
  type Project,
  type RepoFile,
  type RepoIndex,
  resolveId,
  SatiError,
  type ServiceContext,
  type StoredEntity,
  systemClock,
} from "@sati/core";
import { type DbLocation, locateDb, SqliteStore } from "@sati/store-sqlite";

export interface Runtime {
  ctx: ServiceContext;
  project: Project;
  actor: Actor;
  location: DbLocation;
}

let opened: SqliteStore | undefined;

export function currentBranch(location: DbLocation): string | null {
  if (location.mode !== "git") return null;
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

export function osUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/** Large monorepos list many files; the default 1 MB buffer is far too small. */
const LS_FILES_BUFFER = 512 * 1024 * 1024;

/**
 * The git index as `git ls-files -s` reports it: staged blob ids, no file reads. Untracked files
 * and unstaged edits are not seen, so a context entry goes stale once its files are staged.
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
      // Each record: "<mode> <blob> <stage>\t<path>", NUL-terminated so any path is safe.
      for (const rec of git("ls-files", "-s", "-z").split("\0")) {
        const tab = rec.indexOf("\t");
        if (tab < 0) continue;
        const blob = rec.slice(0, tab).split(" ")[1];
        if (blob) out.push({ path: rec.slice(tab + 1), blob });
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
  };
}

/** Opens this project's DB and identifies the caller. Fails with NOT_INITIALIZED before init. */
export async function openRuntime(cwd: string = process.cwd()): Promise<Runtime> {
  const location = locateDb(cwd);
  if (!existsSync(location.path)) {
    throw new SatiError("NOT_INITIALIZED", "This project has no sati yet.", {
      hint: "Run `sati init`.",
    });
  }
  const store = await SqliteStore.open(location.path);
  opened = store;
  const project = await getProject(store);
  const deps = {
    store,
    clock: systemClock,
    ids: createIdFactory(),
    branch: currentBranch(location),
  };
  const identity = actorIdentity({ env: process.env, worktree: location.root, user: osUser() });
  const actor = await ensureActor({ ...deps, projectId: project.id }, identity);
  const ctx: ServiceContext = { ...deps, projectId: project.id, actorId: actor.id };
  if (location.mode !== "standalone") ctx.repo = gitRepoIndex(location.root);
  return { ctx, project, actor, location };
}

/** Splits a comma-separated flag. citty keeps only the last value of a repeated flag. */
export function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function int(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new SatiError("USAGE", `--${flag} must be a whole number, got "${value}".`);
  }
  return n;
}

export async function ref(
  ctx: ServiceContext,
  entity: StoredEntity,
  value: string | undefined,
): Promise<string | undefined> {
  return value === undefined ? undefined : resolveId(ctx, entity, value);
}

export async function refs(
  ctx: ServiceContext,
  entity: StoredEntity,
  value: string | undefined,
): Promise<string[] | undefined> {
  const items = list(value);
  return items && Promise.all(items.map((v) => resolveId(ctx, entity, v)));
}

export function printError(err: unknown, json: boolean): number {
  const e = isSatiError(err)
    ? err
    : new SatiError("INTERNAL", err instanceof Error ? err.message : String(err), {
        hint: "This is a bug in sati. Please report it with the command you ran.",
      });
  if (json) {
    const error = { code: e.code, message: e.message, hint: e.hint ?? null, details: e.details };
    process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`);
  } else {
    process.stderr.write(`error: ${e.message}\n`);
    if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
    if (!isSatiError(err) && err instanceof Error && err.stack && process.env.SATI_DEBUG) {
      process.stderr.write(`${err.stack}\n`);
    }
  }
  return e.exitCode;
}

/**
 * Runs one command: JSON goes to stdout with `--json`, otherwise `render` makes the human text.
 * Errors print a message and a hint, and set the documented exit code.
 */
export async function execute<T>(
  json: boolean | undefined,
  fn: (rt: Runtime) => Promise<T>,
  render: (value: T) => string,
): Promise<void> {
  return output(json, async () => withExport(await openRuntime(), fn), render);
}

/**
 * Git mode exports `.sati/` after a command that wrote, as the MCP server does, so the snapshot
 * is already dirty when git looks: `git commit -a` decides there is nothing to commit before the
 * pre-commit hook runs. A failed export (say, a secret in a record) warns but keeps the write.
 */
async function withExport<T>(rt: Runtime, fn: (rt: Runtime) => Promise<T>): Promise<T> {
  if (rt.project.mode !== "git") return fn(rt);
  const { afterWrites, exportSnapshot } = await import("@sati/sync");
  const dir = join(rt.location.root, CONFIG_DIR);
  const synced = afterWrites(
    rt.ctx.store,
    // Never fires: flush() below runs the export when the command ends.
    2 ** 31 - 1,
    async () => {
      await exportSnapshot(rt.ctx, dir);
    },
    (err) => {
      process.stderr.write("warning: the .sati/ snapshot was not updated.\n");
      printError(err, false);
    },
  );
  try {
    return await fn({ ...rt, ctx: { ...rt.ctx, store: synced.store } });
  } finally {
    await synced.flush();
  }
}

/** Like `execute`, for commands that run before a project exists (`init`). */
export async function output<T>(
  json: boolean | undefined,
  fn: () => Promise<T>,
  render: (value: T) => string,
): Promise<void> {
  try {
    const value = await fn();
    process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${render(value)}\n`);
  } catch (err) {
    process.exitCode = printError(err, json ?? false);
  } finally {
    await closeRuntime();
  }
}

/** Closes the DB opened by `openRuntime`, if any. */
export async function closeRuntime(): Promise<void> {
  await opened?.close();
  opened = undefined;
}
