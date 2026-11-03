import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import {
  type Actor,
  actorIdentity,
  BrainError,
  createIdFactory,
  ensureActor,
  getProject,
  isBrainError,
  type Project,
  resolveId,
  type ServiceContext,
  type StoredEntity,
  systemClock,
} from "@brain/core";
import { type DbLocation, locateDb, SqliteStore } from "@brain/store-sqlite";

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

/** Opens this project's DB and identifies the caller. Fails with NOT_INITIALIZED before init. */
export async function openRuntime(cwd: string = process.cwd()): Promise<Runtime> {
  const location = locateDb(cwd);
  if (!existsSync(location.path)) {
    throw new BrainError("NOT_INITIALIZED", "This project has no brain yet.", {
      hint: "Run `brain init`.",
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
    throw new BrainError("USAGE", `--${flag} must be a whole number, got "${value}".`);
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
  const e = isBrainError(err)
    ? err
    : new BrainError("INTERNAL", err instanceof Error ? err.message : String(err), {
        hint: "This is a bug in brain. Please report it with the command you ran.",
      });
  if (json) {
    const error = { code: e.code, message: e.message, hint: e.hint ?? null, details: e.details };
    process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`);
  } else {
    process.stderr.write(`error: ${e.message}\n`);
    if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
    if (!isBrainError(err) && err instanceof Error && err.stack && process.env.BRAIN_DEBUG) {
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
  return output(json, async () => fn(await openRuntime()), render);
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
