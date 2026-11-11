import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, uptime, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type Actor,
  actorIdentity,
  type BaseConflicts,
  CLI_NAME,
  type ClaimHolder,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  dirtyFromPorcelain,
  ensureActor,
  getProject,
  initProject,
  invalidConfig,
  isSatiError,
  listAll,
  type ProcessProbe,
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
import type { WrittenRecord } from "@sati/sync";
import { writeFileAtomic } from "@sati/sync";
import { watchedSha256 } from "./file-hash.js";
import { defaultBase, samePath } from "./git.js";
import { runHint } from "./install.js";
import { loadFolder, markSeen } from "./shared-folder.js";

export interface Runtime {
  ctx: ServiceContext;
  project: Project;
  actor: Actor;
  location: DbLocation;
}

let opened: StorageAdapter | undefined;

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
function folderIndex(root: string): RepoIndex {
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

/**
 * Names the place a process id means something: this boot of this machine, in this PID namespace.
 * A hostname alone is shared by every cloud sandbox and by containers on host networking, and a
 * clone there must never take another machine's live process for an exited one. Claims are
 * exported to `.sati/` and committed, so the key is a hash, not the names themselves.
 */
function machineKey(): string {
  const parts = [hostname()];
  const read = (f: () => string) => {
    try {
      parts.push(f());
      return true;
    } catch {
      return false;
    }
  };
  const boot = read(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  const pidNs = read(() => readlinkSync("/proc/self/ns/pid"));
  // Without /proc (macOS, Windows): the boot time, to the minute. Two processes that round it
  // differently only see each other as unknown, which never releases anything.
  if (!boot && !pidNs) parts.push(String(Math.round(Date.now() / 60_000 - uptime() / 60)));
  return `h:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

/**
 * Process checks for claim holders. A process on this host is alive while `kill(pid, 0)`
 * succeeds or is refused for permission; `ESRCH` is the one answer that proves it has exited.
 * Another host, or any other error, is unknown. `self` names this process for long-lived
 * servers only (see ProcessProbe).
 */
export function processProbe(long: boolean): ProcessProbe {
  const host = machineKey();
  const probe: ProcessProbe = {
    alive: (holder: ClaimHolder) => {
      if (holder.host !== host) return null;
      try {
        process.kill(holder.pid, 0);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM") return true;
        return code === "ESRCH" ? false : null;
      }
    },
  };
  if (long) probe.self = { host, pid: process.pid };
  return probe;
}

async function resolveLocation(cwd: string): Promise<DbLocation> {
  const slug = process.env.SATI_PROJECT;
  // A folder instead of a slug: a desktop app starts `mcp` outside the project, and two
  // projects may share a slug. A slug has no path separator, so the two cannot be confused.
  if (slug && isAbsolute(slug)) return locateDb(slug);
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
  // The folder can outlive its registry entry. Stop before a second database is made for it.
  if (existsSync(join(root, CONFIG_DIR, CONFIG_FILE))) {
    throw new SatiError("CONFLICT", `A personal workspace already exists at ${root}.`, {
      hint: `It is not in the list of projects on this machine. Run \`${CLI_NAME}\` from that folder, or remove the folder to start a new one.`,
    });
  }
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
export async function openRuntime(
  cwd: string = process.cwd(),
  /** Set by `sati mcp`: the caller is an agent, named `mcp` until the client says who it is. */
  mcpClient?: string,
): Promise<Runtime> {
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
  const identity = actorIdentity({
    env: process.env,
    worktree: location.root,
    user: osUser(),
    mcpClient,
  });
  const actor = await ensureActor({ ...deps, projectId: project.id }, identity);
  const ctx: ServiceContext = {
    ...deps,
    projectId: project.id,
    actorId: actor.id,
    processes: processProbe(false),
  };
  ctx.repo = {
    ...(location.mode === "standalone" ? folderIndex(location.root) : gitRepoIndex(location.root)),
    sha256: watchedSha256(location.root),
  };
  return { ctx, project, actor, location };
}

/**
 * Piped stdin, or "" when stdin is a terminal. Hooks read their JSON input this way, so running
 * one by hand in a terminal does not wait for Ctrl-D (review 5.4).
 */
export function readStdin(): string {
  return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
}

/**
 * Text from a file, or from stdin for `-`. A bad path is a usage error, not a crash, and so is
 * `-` with nothing on stdin: an empty body was almost always a mistaken pipe (review 5.3).
 */
export function readText(path: string): string {
  try {
    if (path !== "-") return readFileSync(path, "utf8");
    const text = readFileSync(0, "utf8");
    if (text.length === 0) {
      throw new SatiError("USAGE", "- reads stdin, and stdin was empty.", {
        hint: "Nothing arrived on stdin. Pipe the text in, or pass it as the value.",
      });
    }
    return text;
  } catch (err) {
    if (isSatiError(err)) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SatiError("NOT_FOUND", `There is no file ${path}.`, {
        hint: "Check the path. It is relative to the folder you run the command in.",
      });
    }
    if (code === "EISDIR") {
      throw new SatiError("USAGE", `${path} is a folder, not a file.`);
    }
    throw new SatiError("USAGE", `Cannot read ${path}: ${(err as Error).message}`);
  }
}

/** A Markdown body flag: `-` reads it from stdin, so long or multi-line text needs no quoting. */
export const bodyText = (value: string | undefined): string | undefined =>
  value === "-" ? readText("-") : value;

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
  opts: { hint?: string } = {},
): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SatiError(
      code,
      `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      {
        hint:
          opts.hint ??
          (code === "USAGE"
            ? "Check the quoting of the value."
            : "Fix the file, or restore it from git."),
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
  if (!value) return value;
  if (value.startsWith("actr_")) return resolveId(ctx, "actor", value);
  const actors = await ctx.store.read((r) => listAll(r, ctx, "actor"));
  const found = actors.find((a) => a.name === value || a.displayName === value);
  if (found) return found.id;
  // An unknown name used to filter by itself and quietly return nothing.
  throw new SatiError("NOT_FOUND", `No actor is named ${value}.`, {
    hint: "Check the spelling, or pass the actor's id or handle (actr_8f3k2a).",
  });
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
  const dir = sharedDir(rt);
  if (!dir) return fn(rt);
  const { afterWrites } = await import("@sati/sync");
  const warn = (err: unknown) => {
    process.stderr.write("warning: the .sati/ snapshot was not updated.\n");
    printError(err, false);
  };
  // No git hook loads a teammate's files in a shared folder, so each command looks first.
  const folder = rt.project.mode === "standalone";
  const db = rt.location.path;
  if (folder) {
    await loadFolder(rt.ctx, dir, db, (err) => {
      process.stderr.write("warning: the shared .sati/ folder was not loaded.\n");
      printError(err, false);
    });
  }
  const synced = afterWrites(
    rt.ctx.store,
    // Never fires: flush() below runs the export when the command ends.
    2 ** 31 - 1,
    async (written) => {
      const files = await exportWritten(rt.ctx, dir, written, warn);
      if (folder) await markSeen(dir, db, files);
    },
    warn,
  );
  try {
    return await fn({ ...rt, ctx: { ...rt.ctx, store: synced.store } });
  } finally {
    await synced.flush();
  }
}

/**
 * Exports the records a debounced batch wrote. Refused records (a secret in a field) are reported,
 * not thrown: a throw puts the whole batch back in the queue, so one bad record would fail every
 * later export and nothing would reach `.sati/` again.
 */
export async function exportWritten(
  ctx: ServiceContext,
  dir: string,
  written: WrittenRecord[],
  report: (err: unknown) => void,
): Promise<string[]> {
  const { exportSnapshot, refusedError } = await import("@sati/sync");
  const result = await exportSnapshot(ctx, dir, { only: written });
  if (result.refused.length > 0) report(refusedError(result.refused));
  return result.written;
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

/**
 * The `.sati/` folder of a project that keeps its records there as files: git mode, or a
 * standalone project shared through a synced folder (ADR 0009). Stealth and a plain standalone
 * project keep nothing outside the database.
 */
export function sharedDir(rt: Pick<Runtime, "project" | "location">): string | undefined {
  const dir = join(rt.location.root, CONFIG_DIR);
  if (rt.project.mode === "git") return dir;
  if (rt.project.mode !== "standalone") return undefined;
  return readProjectConfig(rt.location.root)?.share === true ? dir : undefined;
}

/** `sharedDir`, or a usage error for a project that has no snapshot. */
export function snapshotDir(rt: Runtime): string {
  const dir = sharedDir(rt);
  if (dir) return dir;
  throw new SatiError(
    "USAGE",
    `\`${CLI_NAME} sync\` needs a snapshot in .sati/; this ${rt.project.mode} project keeps none.`,
    {
      hint:
        rt.project.mode === "standalone"
          ? `Run \`${CLI_NAME} sync share\` to share this folder's project through a file-sync app.`
          : "Only git mode keeps a committed snapshot in .sati/.",
    },
  );
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
  if (!parsed.success) throw invalidConfig(file, parsed.error);
  return parsed.data;
}

/**
 * Records the project kind in the committed config, so a teammate's clone gets it too (the
 * project row itself is not in the snapshot). Always written, both values: a config without
 * `kind` (made before kinds existed) means "no opinion", never a switch. Stealth has no file.
 */
/** Turns on sharing through the folder for a standalone project; false when it was on already. */
export function writeConfigShare(root: string): boolean {
  const config = readProjectConfig(root);
  if (!config || config.share === true) return false;
  writeFileAtomic(
    join(root, CONFIG_DIR, CONFIG_FILE),
    `${JSON.stringify({ ...config, share: true }, null, 2)}\n`,
  );
  return true;
}

export function writeConfigKind(root: string, kind: ProjectKind): void {
  const config = readProjectConfig(root);
  if (!config || config.kind === kind) return;
  writeFileAtomic(
    join(root, CONFIG_DIR, CONFIG_FILE),
    `${JSON.stringify({ ...config, kind }, null, 2)}\n`,
  );
}
