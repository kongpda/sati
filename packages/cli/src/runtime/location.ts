import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  type Actor,
  actorIdentity,
  CLI_NAME,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  ensureActor,
  getProject,
  initProject,
  isSatiError,
  type Project,
  SatiError,
  type ServiceContext,
  type StorageAdapter,
  systemClock,
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
import { watchedSha256 } from "../file-hash.js";
import { runHint } from "../install.js";
import { currentBranch, folderIndex, gitRepoIndex } from "./git.js";
import { osUser, processProbe } from "./identity.js";

export interface Runtime {
  ctx: ServiceContext;
  project: Project;
  actor: Actor;
  location: DbLocation;
}

let opened: StorageAdapter | undefined;

async function resolveLocation(cwd: string): Promise<DbLocation> {
  const slug = process.env.SATI_PROJECT;
  // A folder instead of a slug: a desktop app starts `mcp` outside the project, and two
  // projects may share a slug. A slug has no path separator, so the two cannot be confused.
  if (slug && isAbsolute(slug)) return locateDb(slug);
  if (slug) return (await import("../projects.js")).projectLocation(slug);
  try {
    return locateDb(cwd);
  } catch (err) {
    if (!isSatiError(err) || err.code !== "NOT_INITIALIZED") throw err;
    return ensurePersonal();
  }
}

/** First use outside any repo: one standalone workspace at ~/.sati/personal, after a prompt. */
async function ensurePersonal(): Promise<DbLocation> {
  const { readProjects, rememberProject, projectLocation } = await import("../projects.js");
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

/** Closes the DB opened by `openRuntime`, if any. */
export async function closeRuntime(): Promise<void> {
  await opened?.close();
  opened = undefined;
}
