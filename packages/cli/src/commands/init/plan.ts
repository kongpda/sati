import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CLI_NAME,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  MODES,
  type Mode,
  PROJECT_KINDS,
  type Project,
  type ProjectKind,
  readSettings,
  type SatiConfig,
  SatiError,
} from "@sati/core";
import { type DbLocation, locateDb, SqliteStore, standaloneDbPath } from "@sati/store-sqlite";
import { selectTools } from "../../detect.js";
import {
  installedSelf,
  type PlannedGitConfig,
  type PlannedHook,
  planGitAttributes,
  planHooks,
  planMergeDriver,
  selfCommand,
  shownPath,
} from "../../hooks.js";
import {
  type FileChange,
  fileReader,
  type PlannedFile,
  planAgentFiles,
} from "../../integrations.js";
import { readProjectConfig } from "../../runtime/config.js";

export interface InitPlan {
  mode: Mode;
  kind: ProjectKind;
  slug: string;
  name: string;
  root: string;
  db: string;
  projectId: string;
  tools: string[];
  files: FileChange[];
  agentFiles: PlannedFile[];
  /** Git hooks; none in standalone mode. */
  hooks: PlannedHook[];
  /** The merge driver in local git config; git mode only. */
  mergeDriver: PlannedGitConfig | undefined;
  config: SatiConfig;
  /** `--upgrade`: the project exists; hooks, the merge driver and agent files are rewritten. */
  upgrade: Project | undefined;
}

/** Turns a folder name into a valid project slug. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return slug || "project";
}

function sameFolder(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return a === b;
  }
}

export function where(cwd: string): DbLocation | undefined {
  try {
    return locateDb(cwd);
  } catch (err) {
    if (err instanceof SatiError && err.code === "NOT_INITIALIZED") return undefined;
    throw err;
  }
}

async function alreadyInitialized(db: string): Promise<Project | undefined> {
  if (!existsSync(db)) return undefined;
  const store = await SqliteStore.open(db, { readonly: true });
  try {
    return (await store.read((r) => r.getProject())) ?? undefined;
  } finally {
    await store.close();
  }
}

/** Works out everything init will do, without writing anything. */
export async function plan(
  cwd: string,
  args: {
    mode?: string | undefined;
    kind?: string | undefined;
    slug?: string | undefined;
    name?: string | undefined;
    tools?: string | undefined;
    upgrade?: boolean | undefined;
    /** Standalone only: keep the records as files in `.sati/` for a file-sync app (ADR 0009). */
    share?: boolean | undefined;
    /** Also chain into a global `core.hooksPath`, which every repo on the machine uses. */
    globalHooks?: boolean | undefined;
    /** Rules as commands and no MCP configs, for agents with no MCP client. Unset: as it was. */
    cliOnly?: boolean | undefined;
    /** The command hooks start, when not this binary (see `pendingUpgrade`). */
    self?: string[] | undefined;
  },
): Promise<InitPlan> {
  const loc = where(cwd);
  const inGit = loc?.mode === "git";
  const mode = (args.mode ?? (inGit ? "git" : "standalone")) as Mode;
  if (!MODES.includes(mode)) {
    throw new SatiError("USAGE", `Unknown mode "${args.mode}".`, {
      hint: `Use one of: ${MODES.join(", ")}.`,
    });
  }
  if (mode !== "standalone" && !inGit) {
    throw new SatiError("VALIDATION", `${mode} mode needs a git repository.`, {
      hint: `Run \`git init\` first, or use \`${CLI_NAME} init --mode standalone\`.`,
    });
  }
  if (mode === "standalone" && inGit) {
    throw new SatiError("VALIDATION", "Standalone mode is for folders outside git.", {
      hint: `Use \`${CLI_NAME} init --mode git\`, or \`--mode stealth\` to commit nothing.`,
    });
  }
  const root = loc?.root ?? cwd;
  // Every folder below would then belong to this one project, and its agent files would land
  // in the home folder.
  if (mode === "standalone" && (dirname(root) === root || sameFolder(root, homedir()))) {
    throw new SatiError(
      "USAGE",
      "This is your home folder or the top of the disk, not a project.",
      {
        hint: `Open the folder that holds the project's files, then run \`${CLI_NAME} init\` there.`,
      },
    );
  }
  const configPath = join(root, CONFIG_DIR, CONFIG_FILE);
  // A committed config (e.g. in a fresh clone) keeps its project id and kind.
  const existing = readProjectConfig(root);
  // A folder outside git is rarely software: plans, documents and notes need no features or guard.
  const kind = (args.kind ?? existing?.kind ?? (inGit ? "code" : "general")) as ProjectKind;
  if (!PROJECT_KINDS.includes(kind)) {
    throw new SatiError("USAGE", `Unknown project kind "${args.kind}".`, {
      hint: "Use code for software, or general for plans, todos and notes.",
    });
  }
  if (args.share && mode !== "standalone") {
    throw new SatiError(
      "USAGE",
      `--share is for folders outside git; ${mode} mode shares through git.`,
    );
  }
  // A folder someone else shared keeps sharing for whoever joins it.
  const share = mode === "standalone" && (args.share === true || existing?.share === true);
  const projectId = existing?.projectId ?? createIdFactory()("project");
  const db = mode === "standalone" ? standaloneDbPath(homedir(), projectId) : (loc?.path ?? "");

  if (args.upgrade) {
    // An upgrade keeps the project as it is; taking these and ignoring them would look like a change.
    const ignored = (["mode", "kind", "name", "slug"] as const).filter(
      (f) => args[f] !== undefined,
    );
    if (ignored.length > 0) {
      throw new SatiError(
        "USAGE",
        `--upgrade does not change ${ignored.map((f) => `--${f}`).join(", ")}.`,
        {
          hint: `Run \`${CLI_NAME} init --upgrade\` without ${ignored.length === 1 ? "it" : "them"}.`,
        },
      );
    }
  }
  if (args.upgrade && mode === "standalone") {
    throw new SatiError("USAGE", "Standalone projects have no git hooks to upgrade.");
  }
  const found = await alreadyInitialized(db);
  if (found && !args.upgrade) {
    throw new SatiError("CONFLICT", `This project is already initialized as "${found.slug}".`, {
      hint: `Run \`${CLI_NAME} upgrade\` to update its git hooks, merge driver and agent files.`,
    });
  }
  if (!found && args.upgrade) {
    throw new SatiError("NOT_INITIALIZED", "There is no project here to upgrade.", {
      hint: `Run \`${CLI_NAME} init\`.`,
    });
  }
  if (found) {
    return upgradePlan(root, db, found, args.tools, args.globalHooks, args.self, args.cliOnly);
  }

  const name = args.name ?? basename(root);
  const files: FileChange[] =
    mode === "stealth"
      ? []
      : [{ path: shownPath(root, configPath), action: existing ? "keep" : "create" }];
  const tools = selectTools(root, args.tools);
  const agentFiles = planAgentFiles(root, mode, db, kind, tools, args.cliOnly).files;
  // The snapshot only exists in git mode, so only git mode routes it to the merge driver.
  if (mode === "git") agentFiles.push(planGitAttributes(fileReader(root)));
  files.push(...agentFiles.map(({ path, action }) => ({ path, action })));
  const { hooks, mergeDriver } = planGit(root, mode, files, args.globalHooks, args.self);
  return {
    mode,
    kind,
    slug: args.slug ?? slugify(name),
    name,
    root,
    db,
    projectId,
    tools,
    files,
    agentFiles,
    hooks,
    mergeDriver,
    config: { version: 1, projectId, mode, kind, ...(share ? { share: true as const } : {}) },
    upgrade: undefined,
  };
}

/** The hooks and merge driver, appended to `files` in display order. */
function planGit(
  root: string,
  mode: Mode,
  files: FileChange[],
  globalHooks = false,
  self = selfCommand(root),
) {
  const hooks = planHooks(root, mode, self, globalHooks);
  files.push(...hooks.map(({ path, action }) => ({ path, action })));
  const mergeDriver = mode === "git" ? planMergeDriver(root, self) : undefined;
  if (mergeDriver) files.push({ path: mergeDriver.path, action: mergeDriver.action });
  return { hooks, mergeDriver };
}

/** `--upgrade` on an initialized project: everything init and `rules sync` manage, from this version. */
function upgradePlan(
  root: string,
  db: string,
  project: Project,
  askedTools: string | undefined,
  globalHooks: boolean | undefined,
  self: string[] | undefined,
  cliOnly: boolean | undefined,
): InitPlan {
  const mode = project.mode;
  const kind = readSettings(project.settings).kind;
  const tools = selectTools(root, askedTools);
  const agentFiles = planAgentFiles(root, mode, db, kind, tools, cliOnly).files;
  if (mode === "git") agentFiles.push(planGitAttributes(fileReader(root)));
  const files: FileChange[] = agentFiles.map(({ path, action }) => ({ path, action }));
  const { hooks, mergeDriver } = planGit(root, mode, files, globalHooks, self);
  return {
    mode,
    kind,
    slug: project.slug,
    name: project.name,
    root,
    db,
    projectId: project.id,
    tools,
    files,
    agentFiles,
    hooks,
    mergeDriver,
    config: { version: 1, projectId: project.id, mode },
    upgrade: project,
  };
}

/**
 * The files `init --upgrade` would create or change here, for `doctor`. It plans with the
 * binary the hooks already start, so the binary running doctor does not count. An agent file
 * counts only when it exists and is out of date: a missing one belongs to a tool this project
 * does not use, or one the user removed.
 */
export async function pendingUpgrade(root: string): Promise<FileChange[]> {
  const p = await plan(root, { upgrade: true, self: installedSelf(root) });
  const agent = new Set(p.agentFiles.filter((f) => f.path !== ".gitattributes").map((f) => f.path));
  return p.files.filter(
    (f) => f.action === "update" || (f.action === "create" && !agent.has(f.path)),
  );
}

/** The plan without file contents, for `--dry-run` and error details. */
export function summary(p: InitPlan) {
  return {
    ...p,
    config: undefined,
    agentFiles: undefined,
    hooks: undefined,
    mergeDriver: undefined,
  };
}
