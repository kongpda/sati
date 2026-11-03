import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import {
  type Actor,
  actorIdentity,
  type BrainConfig,
  BrainConfigSchema,
  BrainError,
  CONFIG_DIR,
  CONFIG_FILE,
  createIdFactory,
  initProject,
  MODES,
  type Mode,
  type Project,
  systemClock,
} from "@brain/core";
import { type DbLocation, locateDb, SqliteStore, standaloneDbPath } from "@brain/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { selectTools } from "../detect.js";
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
  config: BrainConfig;
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
    if (err instanceof BrainError && err.code === "NOT_INITIALIZED") return undefined;
    throw err;
  }
}

function readConfig(file: string): BrainConfig | undefined {
  if (!existsSync(file)) return undefined;
  const parsed = BrainConfigSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new BrainError("VALIDATION", `Invalid ${file}.`);
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
    throw new BrainError("USAGE", `Unknown mode "${args.mode}".`, {
      hint: `Use one of: ${MODES.join(", ")}.`,
    });
  }
  if (mode !== "standalone" && !inGit) {
    throw new BrainError("VALIDATION", `${mode} mode needs a git repository.`, {
      hint: "Run `git init` first, or use `brain init --mode standalone`.",
    });
  }
  if (mode === "standalone" && inGit) {
    throw new BrainError("VALIDATION", "Standalone mode is for folders outside git.", {
      hint: "Use `brain init --mode git`, or `--mode stealth` to commit nothing.",
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
    throw new BrainError("CONFLICT", `This project is already initialized as "${found.slug}".`, {
      hint: 'Start with `brain task create "title"`.',
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
  files.push(...agentFiles.map(({ path, action }) => ({ path, action })));
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
    config: { version: 1, projectId, mode },
  };
}

function preview(p: InitPlan): string {
  const lines = [`mode      ${p.mode}`, `project   ${p.slug} (${p.name})`, `database  ${p.db}`];
  for (const f of p.files) lines.push(`${f.action.padEnd(9)} ${f.path}`);
  if (p.files.some((f) => f.action === "skip")) {
    lines.push("(stealth mode skips files that already exist, so nothing tracked changes)");
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
    for (const f of p.files) {
      if (f.action !== "create") continue;
      const abs = join(p.root, f.path);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, `${JSON.stringify(p.config, null, 2)}\n`, { flag: "wx" });
    }
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
  clack.intro("brain init");
  const inGit = where(cwd)?.mode === "git";
  const mode = await clack.select<Mode>({
    message: "Where should brain keep this project?",
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
            hint: "DB in ~/.brain, for folders outside git",
          },
        ],
  });
  if (clack.isCancel(mode)) return null;
  const draft = await plan(cwd, { ...args, mode });
  const name = await clack.text({ message: "Project name", initialValue: draft.name });
  if (clack.isCancel(name)) return null;
  const final = await plan(cwd, { ...args, mode, name, slug: args.slug ?? slugify(name) });
  clack.note(preview(final), "brain will write");
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
  lines.push('Next: brain task create "First task"');
  return lines.join("\n");
}

export default defineCommand({
  meta: { name: "init", description: "Set up brain for this project" },
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
        throw new BrainError("USAGE", "brain init needs --yes when it cannot ask questions.", {
          hint: "Run `brain init --yes`, or add `--json` to see what it would write.",
          details: { preview: { ...p, config: undefined, agentFiles: undefined } },
        });
      },
      render,
    ),
});
