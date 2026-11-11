import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type Actor,
  actorIdentity,
  CLI_NAME,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  initProject,
  isSatiError,
  MODES,
  type Mode,
  PROJECT_KINDS,
  type Project,
  type ProjectKind,
  readSettings,
  type SatiConfig,
  SatiError,
  type ServiceContext,
  systemClock,
} from "@sati/core";
import {
  type DbLocation,
  locateDb,
  SqliteStore,
  standaloneDbPath,
  syncedFolder,
} from "@sati/store-sqlite";
import { importSnapshot, writeFileAtomic } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { selectTools } from "../detect.js";
import {
  applyMergeDriver,
  installedSelf,
  type PlannedGitConfig,
  type PlannedHook,
  planGitAttributes,
  planHooks,
  planMergeDriver,
  selfCommand,
  shownPath,
} from "../hooks.js";
import { isLocalInstall, runHint } from "../install.js";
import {
  excludeFileFor,
  type FileAction,
  type FileChange,
  fileReader,
  type PlannedFile,
  planAgentFiles,
  warnIfNotOnPath,
  writePlanned,
} from "../integrations.js";
import { currentBranch, osUser, output, readProjectConfig, writeConfigKind } from "../runtime.js";

interface InitPlan {
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

interface InitResult {
  project: Project;
  actor: Actor;
  db: string;
  tools: string[];
  files: FileChange[];
  /** Records loaded from a committed `.sati/` snapshot, as in a teammate's fresh clone. */
  imported: number;
  /** Hooks that were skipped and why, or what the user must do next. */
  notes: string[];
}

/** Turns a folder name into a valid project slug. */
function slugify(name: string): string {
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

function where(cwd: string): DbLocation | undefined {
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

const LABEL: Record<FileAction, string> = {
  create: "created",
  update: "updated",
  keep: "kept",
  skip: "skipped",
};

/** Works out everything init will do, without writing anything. */
async function plan(
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
      hint: `Run \`${CLI_NAME} init --upgrade\` to update its git hooks, merge driver and agent files.`,
    });
  }
  if (!found && args.upgrade) {
    throw new SatiError("NOT_INITIALIZED", "There is no project here to upgrade.", {
      hint: `Run \`${CLI_NAME} init\`.`,
    });
  }
  if (found) return upgradePlan(root, db, found, args.tools, args.globalHooks, args.self);

  const name = args.name ?? basename(root);
  const files: FileChange[] =
    mode === "stealth"
      ? []
      : [{ path: shownPath(root, configPath), action: existing ? "keep" : "create" }];
  const tools = selectTools(root, args.tools);
  const agentFiles = planAgentFiles(root, mode, db, kind, tools).files;
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
): InitPlan {
  const mode = project.mode;
  const kind = readSettings(project.settings).kind;
  const tools = selectTools(root, askedTools);
  const agentFiles = planAgentFiles(root, mode, db, kind, tools).files;
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

function preview(p: InitPlan): string {
  const lines = [
    `mode      ${p.mode}`,
    `kind      ${p.kind}`,
    `project   ${p.slug} (${p.name})`,
    `database  ${p.db}`,
  ];
  for (const f of p.files) lines.push(`${f.action.padEnd(9)} ${f.path}`);
  if (p.mode === "stealth" && p.agentFiles.some((f) => f.action === "skip")) {
    lines.push("(stealth mode skips files that already exist, so nothing tracked changes)");
  }
  lines.push(...notes(p.hooks));
  if (p.files.length === 0) lines.push("files     none");
  lines.push(`tools     ${p.tools.length ? p.tools.join(", ") : "none detected"}`);
  return lines.join("\n");
}

const notes = (hooks: PlannedHook[]) =>
  hooks.flatMap((h) => (h.note ? [`(${h.path}: ${h.note})`] : []));

/** Writes the hooks, the merge driver and the agent files that `p` plans. */
function writeManaged(p: InitPlan): void {
  for (const h of p.hooks) {
    if (h.action !== "create" && h.action !== "update") continue;
    mkdirSync(join(h.abs, ".."), { recursive: true });
    if (h.action === "create") {
      writeFileSync(h.abs, h.content, { flag: "wx" });
      chmodSync(h.abs, 0o755);
    } else {
      writeFileAtomic(h.abs, h.content, 0o755);
      chmodSync(h.abs, 0o755);
    }
  }
  if (p.mergeDriver) applyMergeDriver(p.root, p.mergeDriver);
  writePlanned(p.root, p.agentFiles, p.mode === "stealth" ? excludeFileFor(p.db) : undefined);
}

interface UpgradeResult {
  upgraded: Project;
  files: FileChange[];
  notes: string[];
}

/**
 * What to tell the user when the database sits in a folder a file-sync app keeps, or undefined.
 * Standalone projects are safe: their database is under `~/.sati`, outside the project folder.
 */
export function syncedDbWarning(db: string): string | undefined {
  const app = syncedFolder(db);
  if (!app) return undefined;
  return `The database (${db}) is in a folder ${app} keeps in sync. A file-sync app copies the database while it is written, which can corrupt it. Move the project out of the synced folder, or pause syncing for it.`;
}

const warnIfSynced = (db: string) => {
  const warning = syncedDbWarning(db);
  if (warning) process.stderr.write(`warning: ${warning}\n`);
};

function applyUpgrade(p: InitPlan & { upgrade: Project }): UpgradeResult {
  writeManaged(p);
  warnIfNotOnPath(p.tools, isLocalInstall(p.root));
  warnIfSynced(p.db);
  return { upgraded: p.upgrade, files: p.files, notes: notes(p.hooks) };
}

/** Loads the committed snapshot. The project is already set up, so a failure says how to retry. */
async function importClone(root: string, ctx: ServiceContext): Promise<number> {
  const dir = join(root, CONFIG_DIR);
  try {
    return (await importSnapshot(ctx, dir)).imported.length;
  } catch (err) {
    if (!isSatiError(err)) throw err;
    throw new SatiError(err.code, `The project is set up, but ${err.message}`, {
      hint: `${err.hint ?? "Fix the snapshot files."} Then run \`${runHint(root, "sync import")}\`.`,
      ...(err.details ? { details: err.details } : {}),
    });
  }
}

async function apply(p: InitPlan): Promise<InitResult | UpgradeResult> {
  if (p.upgrade) return applyUpgrade({ ...p, upgrade: p.upgrade });
  const store = await SqliteStore.open(p.db);
  const ids = createIdFactory();
  // The project id is chosen before the DB exists, so the config file and the row agree.
  const deps = {
    store,
    clock: systemClock,
    ids: (entity: Parameters<typeof ids>[0]) => (entity === "project" ? p.projectId : ids(entity)),
    branch:
      p.mode === "standalone" ? null : currentBranch({ path: p.db, mode: "git", root: p.root }),
  };
  try {
    const { project, actor } = await initProject(
      deps,
      { slug: p.slug, name: p.name, mode: p.mode, kind: p.kind },
      actorIdentity({ env: process.env, worktree: p.root, user: osUser() }),
    );
    // Planned paths use `/` on every platform (`shownPath`), so compare with `/` too.
    const config = p.files.find((f) => f.path === `${CONFIG_DIR}/${CONFIG_FILE}`);
    if (config?.action === "create") {
      const abs = join(p.root, config.path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(p.config, null, 2)}\n`, { flag: "wx" });
    } else if (config) {
      // An explicit --kind in a clone wins over the committed one; record it so the next
      // `sync import` (run by git hooks) does not switch the project back.
      writeConfigKind(p.root, p.kind);
    }
    writeManaged(p);
    warnIfNotOnPath(p.tools, isLocalInstall(p.root));
    warnIfSynced(p.db);
    // Register first: if the snapshot import below fails, the project still exists and is known.
    const { rememberProject } = await import("../projects.js");
    rememberProject({
      slug: project.slug,
      name: project.name,
      projectId: project.id,
      root: p.root,
      mode: project.mode,
      db: p.db,
    });
    // A fresh clone, or a shared folder someone else set up, already has teammates' records in
    // .sati/; without this it starts empty.
    const imported =
      (p.mode === "git" || p.config.share === true) && config?.action === "keep"
        ? await importClone(p.root, { ...deps, projectId: project.id, actorId: actor.id })
        : 0;
    return {
      project,
      actor,
      db: p.db,
      tools: p.tools,
      files: p.files,
      imported,
      notes: notes(p.hooks),
    };
  } finally {
    await store.close();
  }
}

/** The wizard: asks for mode and name, shows the preview, and confirms. */
async function wizard(cwd: string, args: Parameters<typeof plan>[1]): Promise<InitPlan | null> {
  const clack = await import("@clack/prompts");
  clack.intro(`${CLI_NAME} init`);
  const inGit = where(cwd)?.mode === "git";
  const mode = await clack.select<Mode>({
    message: `Where should ${CLI_NAME} keep this project?`,
    initialValue: (args.mode as Mode | undefined) ?? (inGit ? "git" : "standalone"),
    options: inGit
      ? [
          { value: "git", label: "git", hint: "live DB in .git, config committed (default)" },
          { value: "stealth", label: "stealth", hint: "live DB in .git, nothing committed" },
        ]
      : [
          {
            value: "standalone",
            label: "standalone",
            hint: "DB in ~/.sati, for folders outside git",
          },
        ],
  });
  if (clack.isCancel(mode)) return null;
  const kind = await clack.select<ProjectKind>({
    message: "What is this project?",
    // A clone of a general project starts on general, so Enter keeps what teammates chose.
    initialValue: (args.kind ??
      readProjectConfig(where(cwd)?.root ?? cwd)?.kind ??
      (where(cwd)?.mode === "git" ? "code" : "general")) as ProjectKind,
    options: [
      { value: "code", label: "code", hint: "software: features, file locks and the guard" },
      { value: "general", label: "general", hint: "plans, todos and notes, such as an event" },
    ],
  });
  if (clack.isCancel(kind)) return null;
  const draft = await plan(cwd, { ...args, mode, kind });
  const name = await clack.text({ message: "Project name", initialValue: draft.name });
  if (clack.isCancel(name)) return null;
  const globalHooks = await askGlobalHooks(draft, args.globalHooks);
  if (globalHooks === null) return null;
  const final = await plan(cwd, {
    ...args,
    mode,
    kind,
    name,
    slug: args.slug ?? slugify(name),
    globalHooks,
  });
  clack.note(preview(final), `${CLI_NAME} will write`);
  const ok = await clack.confirm({ message: "Create the project?" });
  if (clack.isCancel(ok) || !ok) return null;
  return final;
}

/**
 * A global `core.hooksPath` is shared by every repo on the machine, so writing there needs a yes.
 * Null when the user cancels.
 */
async function askGlobalHooks(p: InitPlan, given: boolean | undefined): Promise<boolean | null> {
  const dir = p.hooks.find((h) => h.global)?.abs;
  if (given || dir === undefined) return Boolean(given);
  const clack = await import("@clack/prompts");
  const ok = await clack.confirm({
    message: `git uses the global core.hooksPath ${dirname(dir)} for every repo on this machine. Chain ${CLI_NAME}'s hooks into it? They do nothing in repos without ${CLI_NAME}.`,
    initialValue: false,
  });
  return clack.isCancel(ok) ? null : ok;
}

/** `--upgrade` asks nothing but whether to go ahead (and about a global hooks folder). */
async function confirmUpgrade(
  cwd: string,
  args: Parameters<typeof plan>[1],
): Promise<InitPlan | null> {
  const draft = await plan(cwd, args);
  const globalHooks = await askGlobalHooks(draft, args.globalHooks);
  if (globalHooks === null) return null;
  const p = globalHooks ? await plan(cwd, { ...args, globalHooks }) : draft;
  const clack = await import("@clack/prompts");
  clack.note(preview(p), `${CLI_NAME} will write`);
  const ok = await clack.confirm({ message: "Apply these changes?" });
  return clack.isCancel(ok) || !ok ? null : p;
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
function summary(p: InitPlan) {
  return {
    ...p,
    config: undefined,
    agentFiles: undefined,
    hooks: undefined,
    mergeDriver: undefined,
  };
}

/** Where Claude Desktop keeps its config, for the hint under the entry. */
const DESKTOP_CONFIG =
  process.platform === "win32"
    ? "%APPDATA%\\Claude\\claude_desktop_config.json"
    : process.platform === "darwin"
      ? "~/Library/Application Support/Claude/claude_desktop_config.json"
      : "~/.config/Claude/claude_desktop_config.json";

interface DesktopEntry {
  desktop: { mcpServers: Record<string, { command: string; args: string[] }> };
}

/**
 * The entry a desktop app needs to start this project's MCP server. The app starts servers in
 * its own folder and without the shell's PATH, so the entry names Node, this script and the
 * project folder in full.
 */
export function desktopEntry(cwd: string, script = process.argv[1] ?? CLI_NAME): DesktopEntry {
  const { root, path } = locateDb(cwd);
  if (!existsSync(path)) {
    throw new SatiError("NOT_INITIALIZED", `This project has no ${CLI_NAME} yet.`, {
      hint: `Run \`${CLI_NAME} init\` first.`,
    });
  }
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return {
    desktop: {
      mcpServers: {
        [slug ? `${CLI_NAME}-${slug}` : CLI_NAME]: {
          command: process.execPath,
          args: [script, "mcp", "--project", root],
        },
      },
    },
  };
}

interface DryRun {
  dryRun: ReturnType<typeof summary>;
}

function render(r: InitResult | UpgradeResult | DryRun | DesktopEntry | null): string {
  if (!r) return "Cancelled. Nothing was written.";
  if ("desktop" in r) {
    return [
      `Add this to ${DESKTOP_CONFIG} (merge it into "mcpServers" if the file has one),`,
      "then restart Claude Desktop. Nothing was written.",
      "",
      JSON.stringify(r.desktop, null, 2),
    ].join("\n");
  }
  if ("dryRun" in r) {
    const p = r.dryRun;
    const head = p.upgrade ? `Upgrade "${p.upgrade.slug}" would write:` : "Init would write:";
    const lines = [head, `  mode      ${p.mode}`];
    if (!p.upgrade) lines.push(`  kind      ${p.kind}`);
    for (const f of p.files) lines.push(`  ${f.action.padEnd(9)} ${f.path}`);
    lines.push(`  tools     ${p.tools.length ? p.tools.join(", ") : "none detected"}`);
    lines.push("Dry run: nothing was written.");
    return lines.join("\n");
  }
  if ("upgraded" in r) {
    const lines = [`Upgraded "${r.upgraded.slug}" (${r.upgraded.mode} mode).`];
    for (const f of r.files) lines.push(`  ${LABEL[f.action].padEnd(9)} ${f.path}`);
    return [...lines, ...r.notes.map((n) => `  ${n}`)].join("\n");
  }
  const lines = [
    `Initialized "${r.project.slug}" in ${r.project.mode} mode${readSettings(r.project.settings).kind === "general" ? " as a general project" : ""}.`,
    `  database  ${r.db}`,
  ];
  for (const f of r.files) lines.push(`  ${LABEL[f.action].padEnd(9)} ${f.path}`);
  lines.push(...r.notes.map((n) => `  ${n}`));
  lines.push(`  tools     ${r.tools.length ? r.tools.join(", ") : "none detected"}`);
  if (r.imported > 0) {
    lines.push(`  imported  ${r.imported} record(s) from ${CONFIG_DIR}/`);
    lines.push(`Next: ${CLI_NAME} next`);
  } else {
    lines.push(`Next: ${CLI_NAME} task create "First task"`);
  }
  return lines.join("\n");
}

export default defineCommand({
  meta: { name: "init", description: `Set up ${CLI_NAME} for this project` },
  args: {
    mode: {
      type: "string",
      description: "git (default in a repo) | stealth | standalone (outside git only)",
    },
    kind: {
      type: "string",
      description:
        "code (default in a repo) | general (default outside git): plans, todos and notes without features or locks",
    },
    name: { type: "string", description: "Project name (default: folder name)" },
    slug: {
      type: "string",
      description: "Project slug: lowercase letters, digits and dashes (default: from the name)",
    },
    tools: {
      type: "string",
      description:
        "Also set up these agent tools, added to the ones detected, comma-separated (e.g. claude-code,codex)",
    },
    yes: {
      type: "boolean",
      description:
        "Skip prompts and accept the defaults (required without a terminal, or with --json)",
    },
    upgrade: {
      type: "boolean",
      description:
        "Update the git hooks, merge driver and agent files (as `rules sync` does) of an initialized project. Exit 6 if there is none",
    },
    share: {
      type: "boolean",
      description:
        "Outside git: share the project through this folder. Records are kept as files in .sati/ for a file-sync app (Dropbox, OneDrive, a file server) to carry; the database stays on this machine",
    },
    "dry-run": { type: "boolean", description: "Show what init would write, and write nothing" },
    desktop: {
      type: "boolean",
      description:
        "Print the Claude Desktop config entry for this initialized project, and write nothing",
    },
    "global-hooks": {
      type: "boolean",
      description:
        "Also chain the git hooks into a global core.hooksPath, which every repo on this machine uses",
    },
    ...json,
  },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        const cwd = process.cwd();
        if (args.desktop) return desktopEntry(cwd);
        const opts = {
          mode: args.mode,
          kind: args.kind,
          name: args.name,
          slug: args.slug,
          tools: args.tools,
          upgrade: args.upgrade,
          share: args.share,
          globalHooks: args["global-hooks"],
        };
        if (args["dry-run"]) return { dryRun: summary(await plan(cwd, opts)) };
        if (args.yes) return apply(await plan(cwd, opts));
        if (!args.json && process.stdin.isTTY && process.stdout.isTTY) {
          const chosen = args.upgrade ? await confirmUpgrade(cwd, opts) : await wizard(cwd, opts);
          return chosen && apply(chosen);
        }
        const p = await plan(cwd, opts);
        const flags = args.upgrade ? "--upgrade " : "";
        throw new SatiError("USAGE", `${CLI_NAME} init needs --yes when it cannot ask questions.`, {
          hint: `Run \`${CLI_NAME} init ${flags}--yes\`, or \`${CLI_NAME} init ${flags}--dry-run\` to see what it would write.`,
          details: { preview: summary(p) },
        });
      },
      render,
    ),
});
