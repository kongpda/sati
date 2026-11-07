import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
import { type DbLocation, locateDb, SqliteStore, standaloneDbPath } from "@sati/store-sqlite";
import { importSnapshot } from "@sati/sync";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { selectTools } from "../detect.js";
import {
  applyMergeDriver,
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
  planIntegrations,
  readExcluded,
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
  /** `--upgrade`: the project exists; only hooks, the merge driver and .gitattributes change. */
  upgrade: Project | undefined;
}

export interface InitResult {
  project: Project;
  actor: Actor;
  db: string;
  tools: string[];
  files: FileChange[];
  /** Records loaded from a committed `.sati/` snapshot, as in a teammate's fresh clone. */
  imported: number;
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
  const configPath = join(root, CONFIG_DIR, CONFIG_FILE);
  // A committed config (e.g. in a fresh clone) keeps its project id and kind.
  const existing = readProjectConfig(root);
  const kind = (args.kind ?? existing?.kind ?? "code") as ProjectKind;
  if (!PROJECT_KINDS.includes(kind)) {
    throw new SatiError("USAGE", `Unknown project kind "${args.kind}".`, {
      hint: "Use code for software, or general for plans, todos and notes.",
    });
  }
  const projectId = existing?.projectId ?? createIdFactory()("project");
  const db = mode === "standalone" ? standaloneDbPath(homedir(), projectId) : (loc?.path ?? "");

  if (args.upgrade && mode === "standalone") {
    throw new SatiError("USAGE", "Standalone projects have no git hooks to upgrade.");
  }
  const found = await alreadyInitialized(db);
  if (found && !args.upgrade) {
    throw new SatiError("CONFLICT", `This project is already initialized as "${found.slug}".`, {
      hint: `Run \`${CLI_NAME} init --upgrade\` to update its git hooks, merge driver and .gitattributes.`,
    });
  }
  if (!found && args.upgrade) {
    throw new SatiError("NOT_INITIALIZED", "There is no project here to upgrade.", {
      hint: `Run \`${CLI_NAME} init\`.`,
    });
  }
  if (found) return upgradePlan(root, db, found);

  const name = args.name ?? basename(root);
  const files: FileChange[] =
    mode === "stealth"
      ? []
      : [{ path: shownPath(root, configPath), action: existing ? "keep" : "create" }];
  const tools = selectTools(root, args.tools);
  const excluded = mode === "stealth" ? readExcluded(excludeFileFor(db)) : new Set<string>();
  const agentFiles = planIntegrations(
    tools,
    mode,
    fileReader(root),
    (path) => path === "CLAUDE.local.md" || excluded.has(path),
    isLocalInstall(root),
    kind,
  );
  // The snapshot only exists in git mode, so only git mode routes it to the merge driver.
  if (mode === "git") agentFiles.push(planGitAttributes(fileReader(root)));
  files.push(...agentFiles.map(({ path, action }) => ({ path, action })));
  const { hooks, mergeDriver } = planGit(root, mode, files);
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
    config: { version: 1, projectId, mode, kind },
    upgrade: undefined,
  };
}

/** The hooks and merge driver, appended to `files` in display order. */
function planGit(root: string, mode: Mode, files: FileChange[]) {
  const self = selfCommand(root);
  const hooks = planHooks(root, mode, self);
  files.push(...hooks.map(({ path, action }) => ({ path, action })));
  const mergeDriver = mode === "git" ? planMergeDriver(root, self) : undefined;
  if (mergeDriver) files.push({ path: mergeDriver.path, action: mergeDriver.action });
  return { hooks, mergeDriver };
}

/** `--upgrade` on an initialized project: only the git integration that init manages. */
function upgradePlan(root: string, db: string, project: Project): InitPlan {
  const mode = project.mode;
  const agentFiles = mode === "git" ? [planGitAttributes(fileReader(root))] : [];
  const files: FileChange[] = agentFiles.map(({ path, action }) => ({ path, action }));
  const { hooks, mergeDriver } = planGit(root, mode, files);
  return {
    mode,
    kind: readSettings(project.settings).kind,
    slug: project.slug,
    name: project.name,
    root,
    db,
    projectId: project.id,
    tools: [],
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
  if (!p.upgrade) lines.push(`tools     ${p.tools.length ? p.tools.join(", ") : "none detected"}`);
  return lines.join("\n");
}

const notes = (hooks: PlannedHook[]) =>
  hooks.flatMap((h) => (h.note ? [`(${h.path}: ${h.note})`] : []));

/** Writes the hooks, the merge driver and the agent files that `p` plans. */
function writeManaged(p: InitPlan): void {
  for (const h of p.hooks) {
    if (h.action !== "create" && h.action !== "update") continue;
    mkdirSync(join(h.abs, ".."), { recursive: true });
    writeFileSync(h.abs, h.content, { flag: h.action === "create" ? "wx" : "w" });
    chmodSync(h.abs, 0o755);
  }
  if (p.mergeDriver) applyMergeDriver(p.root, p.mergeDriver);
  writePlanned(p.root, p.agentFiles, p.mode === "stealth" ? excludeFileFor(p.db) : undefined);
}

export interface UpgradeResult {
  upgraded: Project;
  files: FileChange[];
  notes: string[];
}

function applyUpgrade(p: InitPlan & { upgrade: Project }): UpgradeResult {
  writeManaged(p);
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
    // A fresh clone already has teammates' records in .sati/; without this it starts empty.
    const imported =
      p.mode === "git" && config?.action === "keep"
        ? await importClone(p.root, { ...deps, projectId: project.id, actorId: actor.id })
        : 0;
    return { project, actor, db: p.db, tools: p.tools, files: p.files, imported };
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
      "code") as ProjectKind,
    options: [
      { value: "code", label: "code", hint: "software: features, file locks and the guard" },
      { value: "general", label: "general", hint: "plans, todos and notes, such as an event" },
    ],
  });
  if (clack.isCancel(kind)) return null;
  const draft = await plan(cwd, { ...args, mode, kind });
  const name = await clack.text({ message: "Project name", initialValue: draft.name });
  if (clack.isCancel(name)) return null;
  const final = await plan(cwd, { ...args, mode, kind, name, slug: args.slug ?? slugify(name) });
  clack.note(preview(final), `${CLI_NAME} will write`);
  const ok = await clack.confirm({ message: "Create the project?" });
  if (clack.isCancel(ok) || !ok) return null;
  return final;
}

/** `--upgrade` asks nothing but whether to go ahead. */
async function confirmUpgrade(p: InitPlan): Promise<InitPlan | null> {
  const clack = await import("@clack/prompts");
  clack.note(preview(p), `${CLI_NAME} will write`);
  const ok = await clack.confirm({ message: "Apply these changes?" });
  return clack.isCancel(ok) || !ok ? null : p;
}

function render(r: InitResult | UpgradeResult | null): string {
  if (!r) return "Cancelled. Nothing was written.";
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
    mode: { type: "string", description: "git | stealth | standalone" },
    kind: {
      type: "string",
      description: "code (default) | general: plans, todos and notes without features or locks",
    },
    name: { type: "string", description: "Project name (default: folder name)" },
    slug: { type: "string", description: "Project slug (default: from the name)" },
    tools: {
      type: "string",
      description: "Also set up these agent tools, comma-separated (e.g. claude-code,codex)",
    },
    yes: { type: "boolean", description: "Skip prompts and accept the defaults" },
    upgrade: {
      type: "boolean",
      description:
        "Update the git hooks, merge driver and .gitattributes of an initialized project",
    },
    ...json,
  },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        const cwd = process.cwd();
        const opts = {
          mode: args.mode,
          kind: args.kind,
          name: args.name,
          slug: args.slug,
          tools: args.tools,
          upgrade: args.upgrade,
        };
        if (args.yes) return apply(await plan(cwd, opts));
        if (!args.json && process.stdin.isTTY && process.stdout.isTTY) {
          const chosen = args.upgrade
            ? await confirmUpgrade(await plan(cwd, opts))
            : await wizard(cwd, opts);
          return chosen && apply(chosen);
        }
        const p = await plan(cwd, opts);
        const yes = args.upgrade ? "--upgrade --yes" : "--yes";
        throw new SatiError("USAGE", `${CLI_NAME} init needs --yes when it cannot ask questions.`, {
          hint: `Run \`sati init ${yes}\`, or add \`--json\` to see what it would write.`,
          details: {
            preview: {
              ...p,
              config: undefined,
              agentFiles: undefined,
              hooks: undefined,
              mergeDriver: undefined,
            },
          },
        });
      },
      render,
    ),
});
