import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  type Actor,
  actorIdentity,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  initProject,
  MODES,
  type Mode,
  type Project,
  type SatiConfig,
  SatiConfigSchema,
  SatiError,
  systemClock,
} from "@sati/core";
import { type DbLocation, locateDb, SqliteStore, standaloneDbPath } from "@sati/store-sqlite";
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
} from "../hooks.js";
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
import { currentBranch, osUser, output } from "../runtime.js";

interface InitPlan {
  mode: Mode;
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
}

export interface InitResult {
  project: Project;
  actor: Actor;
  db: string;
  tools: string[];
  files: FileChange[];
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

function where(cwd: string): DbLocation | undefined {
  try {
    return locateDb(cwd);
  } catch (err) {
    if (err instanceof SatiError && err.code === "NOT_INITIALIZED") return undefined;
    throw err;
  }
}

function readConfig(file: string): SatiConfig | undefined {
  if (!existsSync(file)) return undefined;
  const parsed = SatiConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new SatiError("VALIDATION", `Invalid ${file}.`);
  return parsed.data;
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
    slug?: string | undefined;
    name?: string | undefined;
    tools?: string | undefined;
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
      hint: "Run `git init` first, or use `sati init --mode standalone`.",
    });
  }
  if (mode === "standalone" && inGit) {
    throw new SatiError("VALIDATION", "Standalone mode is for folders outside git.", {
      hint: "Use `sati init --mode git`, or `--mode stealth` to commit nothing.",
    });
  }
  const root = loc?.root ?? cwd;
  const configPath = join(root, CONFIG_DIR, CONFIG_FILE);
  // A committed config (e.g. in a fresh clone) keeps its project id.
  const existing = readConfig(configPath);
  const projectId = existing?.projectId ?? createIdFactory()("project");
  const db = mode === "standalone" ? standaloneDbPath(homedir(), projectId) : (loc?.path ?? "");

  const found = await alreadyInitialized(db);
  if (found) {
    throw new SatiError("CONFLICT", `This project is already initialized as "${found.slug}".`, {
      hint: 'Start with `sati task create "title"`.',
    });
  }

  const name = args.name ?? basename(root);
  const files: FileChange[] =
    mode === "stealth"
      ? []
      : [{ path: relative(root, configPath), action: existing ? "keep" : "create" }];
  const tools = selectTools(root, args.tools);
  const excluded = mode === "stealth" ? readExcluded(excludeFileFor(db)) : new Set<string>();
  const agentFiles = planIntegrations(
    tools,
    mode,
    fileReader(root),
    (path) => path === "CLAUDE.local.md" || excluded.has(path),
  );
  // The snapshot only exists in git mode, so only git mode routes it to the merge driver.
  if (mode === "git") agentFiles.push(planGitAttributes(fileReader(root)));
  files.push(...agentFiles.map(({ path, action }) => ({ path, action })));
  const hooks = planHooks(root, mode);
  files.push(...hooks.map(({ path, action }) => ({ path, action })));
  const mergeDriver = mode === "git" ? planMergeDriver(root) : undefined;
  if (mergeDriver) files.push({ path: mergeDriver.path, action: mergeDriver.action });
  return {
    mode,
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
    config: { version: 1, projectId, mode },
  };
}

function preview(p: InitPlan): string {
  const lines = [`mode      ${p.mode}`, `project   ${p.slug} (${p.name})`, `database  ${p.db}`];
  for (const f of p.files) lines.push(`${f.action.padEnd(9)} ${f.path}`);
  if (p.mode === "stealth" && p.agentFiles.some((f) => f.action === "skip")) {
    lines.push("(stealth mode skips files that already exist, so nothing tracked changes)");
  }
  for (const h of p.hooks.filter((h) => h.action === "skip")) {
    lines.push(`(${h.path} already exists and is left alone; call sati from it yourself)`);
  }
  if (p.files.length === 0) lines.push("files     none");
  lines.push(`tools     ${p.tools.length ? p.tools.join(", ") : "none detected"}`);
  return lines.join("\n");
}

async function apply(p: InitPlan): Promise<InitResult> {
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
      { slug: p.slug, name: p.name, mode: p.mode },
      actorIdentity({ env: process.env, worktree: p.root, user: osUser() }),
    );
    const config = p.files.find((f) => f.path === join(CONFIG_DIR, CONFIG_FILE));
    if (config?.action === "create") {
      const abs = join(p.root, config.path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(p.config, null, 2)}\n`, { flag: "wx" });
    }
    for (const h of p.hooks) {
      if (h.action !== "create" && h.action !== "update") continue;
      mkdirSync(join(h.abs, ".."), { recursive: true });
      writeFileSync(h.abs, h.content, { flag: h.action === "create" ? "wx" : "w" });
      chmodSync(h.abs, 0o755);
    }
    if (p.mergeDriver) applyMergeDriver(p.root, p.mergeDriver);
    writePlanned(p.root, p.agentFiles, p.mode === "stealth" ? excludeFileFor(p.db) : undefined);
    warnIfNotOnPath(p.tools);
    return { project, actor, db: p.db, tools: p.tools, files: p.files };
  } finally {
    await store.close();
  }
}

/** The wizard: asks for mode and name, shows the preview, and confirms. */
async function wizard(cwd: string, args: Parameters<typeof plan>[1]): Promise<InitPlan | null> {
  const clack = await import("@clack/prompts");
  clack.intro("sati init");
  const inGit = where(cwd)?.mode === "git";
  const mode = await clack.select<Mode>({
    message: "Where should sati keep this project?",
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
  const draft = await plan(cwd, { ...args, mode });
  const name = await clack.text({ message: "Project name", initialValue: draft.name });
  if (clack.isCancel(name)) return null;
  const final = await plan(cwd, { ...args, mode, name, slug: args.slug ?? slugify(name) });
  clack.note(preview(final), "sati will write");
  const ok = await clack.confirm({ message: "Create the project?" });
  if (clack.isCancel(ok) || !ok) return null;
  return final;
}

function render(r: InitResult | null): string {
  if (!r) return "Cancelled. Nothing was written.";
  const lines = [
    `Initialized "${r.project.slug}" in ${r.project.mode} mode.`,
    `  database  ${r.db}`,
  ];
  for (const f of r.files) lines.push(`  ${LABEL[f.action].padEnd(9)} ${f.path}`);
  lines.push(`  tools     ${r.tools.length ? r.tools.join(", ") : "none detected"}`);
  lines.push('Next: sati task create "First task"');
  return lines.join("\n");
}

export default defineCommand({
  meta: { name: "init", description: "Set up sati for this project" },
  args: {
    mode: { type: "string", description: "git | stealth | standalone" },
    name: { type: "string", description: "Project name (default: folder name)" },
    slug: { type: "string", description: "Project slug (default: from the name)" },
    tools: {
      type: "string",
      description: "Also set up these agent tools, comma-separated (e.g. claude-code,codex)",
    },
    yes: { type: "boolean", description: "Skip prompts and accept the defaults" },
    ...json,
  },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        const cwd = process.cwd();
        const opts = { mode: args.mode, name: args.name, slug: args.slug, tools: args.tools };
        if (args.yes) return apply(await plan(cwd, opts));
        if (!args.json && process.stdin.isTTY && process.stdout.isTTY) {
          const chosen = await wizard(cwd, opts);
          return chosen && apply(chosen);
        }
        const p = await plan(cwd, opts);
        throw new SatiError("USAGE", "sati init needs --yes when it cannot ask questions.", {
          hint: "Run `sati init --yes`, or add `--json` to see what it would write.",
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
