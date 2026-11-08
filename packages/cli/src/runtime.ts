import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  type Actor,
  actorIdentity,
  CLI_NAME,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  dirtyFromPorcelain,
  ensureActor,
  getProject,
  initProject,
  isSatiError,
  listAll,
  type Project,
  type ProjectKind,
  type RepoFile,
  type RepoIndex,
  resolveId,
  type SatiConfig,
  SatiConfigSchema,
  SatiError,
  type ServiceContext,
  type StorageAdapter,
  type StoredEntity,
  systemClock,
  withoutStamps,
} from "@sati/core";
import {
  connectStore,
  type DbLocation,
  filesystemKind,
  locateDb,
  SqliteStore,
  socketPath as socketPathFor,
  standaloneDbPath,
} from "@sati/store-sqlite";
import { runHint } from "./install.js";

export interface Runtime {
  ctx: ServiceContext;
  project: Project;
  actor: Actor;
  location: DbLocation;
}

let opened: StorageAdapter | undefined;

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
      // Each record: "<mode> <blob> <stage>\t<path>", NUL-terminated so any path is safe.
      for (const rec of git("ls-files", "-s", "-z").split("\0")) {
        const tab = rec.indexOf("\t");
        if (tab < 0) continue;
        const blob = rec.slice(0, tab).split(" ")[1];
        if (blob) out.push({ path: rec.slice(tab + 1), blob });
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
            blob = `wt:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
          } catch {
            continue; // vanished or unreadable: one file must not drop every other dirty hash
          }
        }
        const at = out.findIndex((f) => f.path === change.path);
        if (at >= 0) out[at] = { path: change.path, blob };
        else out.push({ path: change.path, blob });
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

async function resolveLocation(cwd: string): Promise<DbLocation> {
  const slug = process.env.SATI_PROJECT;
  if (slug) return (await import("./projects.js")).projectLocation(slug);
  try {
    return locateDb(cwd);
  } catch (err) {
    if (!isSatiError(err) || err.code !== "NOT_INITIALIZED") throw err;
    return ensurePersonal();
  }
}

/** First use outside any repo: one standalone workspace at ~/.sati/personal, after a prompt. */
async function ensurePersonal(): Promise<DbLocation> {
  const { readProjects, rememberProject, projectLocation } = await import("./projects.js");
  const existing = readProjects().find((p) => p.slug === "personal" && existsSync(p.db));
  if (existing) return projectLocation("personal");
  if (process.env.SATI_YES !== "1") {
    if (!process.stdin.isTTY) {
      throw new SatiError("NOT_INITIALIZED", "No git repository or standalone project found.", {
        hint: `Run \`${CLI_NAME} init\` in a repository, or \`SATI_YES=1\` to create a personal workspace at ~/.sati/personal.`,
      });
    }
    const clack = await import("@clack/prompts");
    const ok = await clack.confirm({
      message: "No project here. Create a personal workspace at ~/.sati/personal?",
    });
    if (clack.isCancel(ok) || ok !== true) {
      throw new SatiError("USAGE", "No project selected.", {
        hint: `Run \`${CLI_NAME} init\` in a repository.`,
      });
    }
  }
  const home = homedir();
  const root = join(home, ".sati", "personal");
  const ids = createIdFactory();
  const projectId = ids("project");
  const db = standaloneDbPath(home, projectId);
  const store = await SqliteStore.open(db);
  try {
    const { project } = await initProject(
      {
        store,
        clock: systemClock,
        ids: (entity) => (entity === "project" ? projectId : ids(entity)),
        branch: null,
      },
      { slug: "personal", name: "Personal", mode: "standalone" },
      actorIdentity({ env: process.env, worktree: root, user: osUser() }),
    );
    const configPath = join(root, CONFIG_DIR, CONFIG_FILE);
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      `${JSON.stringify({ version: 1, projectId: project.id, mode: "standalone" }, null, 2)}\n`,
      { flag: "wx" },
    );
    rememberProject({
      slug: project.slug,
      name: project.name,
      projectId: project.id,
      root,
      mode: "standalone",
      db,
    });
    return { path: db, root, mode: "standalone" };
  } finally {
    await store.close();
  }
}

/** Opens this project's DB and identifies the caller. Fails with NOT_INITIALIZED before init. */
export async function openRuntime(cwd: string = process.cwd()): Promise<Runtime> {
  const location = await resolveLocation(cwd);
  if (!existsSync(location.path)) {
    throw new SatiError("NOT_INITIALIZED", `This project has no ${CLI_NAME} yet.`, {
      hint: `Run \`${runHint(location.root, "init")}\`.`,
    });
  }
  const socketPath = socketPathFor(location.path);
  const kind = filesystemKind(dirname(location.path));
  const store =
    process.env.SATI_DAEMON_OWNER === "1"
      ? await SqliteStore.open(location.path)
      : kind === "local"
        ? await SqliteStore.open(location.path)
        : existsSync(socketPath)
          ? connectStore(socketPath)
          : (() => {
              throw new SatiError(
                "USAGE",
                `The database is on a ${kind} filesystem, which is unsafe for SQLite.`,
                { hint: `Run \`${CLI_NAME} serve\` in this project, then retry.` },
              );
            })();
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
  ctx.repo =
    location.mode === "standalone" ? folderIndex(location.root) : gitRepoIndex(location.root);
  return { ctx, project, actor, location };
}

/**
 * Splits a comma-separated flag. citty keeps only the last value of a repeated flag. A comma
 * inside `{}` belongs to a glob such as `src/{a,b}/**`, so it does not split.
 */
export function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "{") depth++;
    else if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function int(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  // Number() would take "", "1e3" and "0x10"; a flag is a plain decimal integer.
  const n = Number(value);
  if (!/^-?\d+$/.test(value.trim()) || !Number.isSafeInteger(n)) {
    throw new SatiError("USAGE", `--${flag} must be a whole number, got "${value}".`);
  }
  return n;
}

/** `JSON.parse` for user input and files: bad JSON is the caller's mistake, not a bug in sati. */
export function parseJson(
  text: string,
  what: string,
  code: "USAGE" | "VALIDATION" = "VALIDATION",
): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SatiError(
      code,
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        hint:
          code === "USAGE"
            ? "Check the quoting of the value."
            : "Fix the file, or restore it from git.",
      },
    );
  }
}

export async function ref(
  ctx: ServiceContext,
  entity: StoredEntity,
  value: string | undefined,
): Promise<string | undefined> {
  return value === undefined ? undefined : resolveId(ctx, entity, value);
}

/** An actor id, or the id of the actor with this name; an unknown name is passed through. */
export async function actorRef(
  ctx: ServiceContext,
  value: string | undefined,
): Promise<string | undefined> {
  if (!value || value.startsWith("actr_")) return value;
  const actors = await ctx.store.read((r) => listAll(r, ctx, "actor"));
  return actors.find((a) => a.name === value || a.displayName === value)?.id ?? value;
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
        hint: `This is a bug in ${CLI_NAME}. Please report it with the command you ran.`,
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
export async function withExport<T>(rt: Runtime, fn: (rt: Runtime) => Promise<T>): Promise<T> {
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
    const text = json ? JSON.stringify(value, withoutStamps, 2) : render(value);
    // An empty rendering prints nothing at all (a quiet git hook), not a blank line.
    if (text !== "") process.stdout.write(`${text}\n`);
  } catch (err) {
    process.exitCode = printError(err, json ?? false);
  } finally {
    await closeRuntime();
  }
}

/** The `.sati/` folder. Only git mode has one: stealth and standalone commit nothing. */
export function snapshotDir(rt: Runtime): string {
  if (rt.project.mode !== "git") {
    throw new SatiError(
      "USAGE",
      `\`${CLI_NAME} sync\` needs git mode; this project is ${rt.project.mode}.`,
      { hint: "Only git mode keeps a committed snapshot in .sati/." },
    );
  }
  return join(rt.location.root, CONFIG_DIR);
}

/** Closes the DB opened by `openRuntime`, if any. */
export async function closeRuntime(): Promise<void> {
  await opened?.close();
  opened = undefined;
}

/** `.sati/sati.config.json` of a project, or undefined when it has none (stealth mode). */
export function readProjectConfig(root: string): SatiConfig | undefined {
  const file = join(root, CONFIG_DIR, CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = SatiConfigSchema.safeParse(parseJson(readFileSync(file, "utf8"), file));
  if (!parsed.success) throw new SatiError("VALIDATION", `Invalid ${file}.`);
  return parsed.data;
}

/**
 * Records the project kind in the committed config, so a teammate's clone gets it too (the
 * project row itself is not in the snapshot). Always written, both values: a config without
 * `kind` (made before kinds existed) means "no opinion", never a switch. Stealth has no file.
 */
export function writeConfigKind(root: string, kind: ProjectKind): void {
  const config = readProjectConfig(root);
  if (!config || config.kind === kind) return;
  writeFileSync(
    join(root, CONFIG_DIR, CONFIG_FILE),
    `${JSON.stringify({ ...config, kind }, null, 2)}\n`,
  );
}
