import { dirname } from "node:path";
import {
  CLI_NAME,
  CONFIG_DIR,
  type Mode,
  type ProjectKind,
  readSettings,
  SatiError,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../../args.js";
import { readProjectConfig } from "../../runtime/config.js";
import { output } from "../../runtime/output.js";
import { apply, type InitResult, LABEL, notes, type UpgradeResult } from "./apply.js";
import { type DesktopEntry, desktopEntry, desktopText } from "./desktop.js";
import { type InitPlan, plan, slugify, summary, where } from "./plan.js";

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

interface DryRun {
  dryRun: ReturnType<typeof summary>;
}

function render(r: InitResult | UpgradeResult | DryRun | DesktopEntry | null): string {
  if (!r) return "Cancelled. Nothing was written.";
  if ("desktop" in r) return desktopText(r);
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
        "Update the git hooks, merge driver and agent files of an initialized project. Exit 6 if there is none",
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
    "cli-only": {
      type: "boolean",
      description:
        "Write the rules as commands, for agents with no MCP client, and add no MCP configs. Kept by later runs; `upgrade --no-cli-only` goes back",
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
          cliOnly: args["cli-only"],
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

/**
 * `upgrade`: the work of `init --upgrade --yes` under a short name. It asks nothing: it only
 * rewrites files this tool manages, and `--dry-run` shows them first.
 */
export const upgradeCommand = defineCommand({
  meta: {
    name: "upgrade",
    description: "Update this project's git hooks, merge driver and agent files",
  },
  args: {
    tools: {
      type: "string",
      description:
        "Also set up these agent tools, added to the ones detected, comma-separated (e.g. claude-code,codex)",
    },
    "dry-run": { type: "boolean", description: "Show what it would write, and write nothing" },
    "cli-only": {
      type: "boolean",
      description:
        "Write the rules as commands, for agents with no MCP client, and add no MCP configs. Kept by later runs; --no-cli-only goes back to the MCP tool names",
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
        const p = await plan(process.cwd(), {
          upgrade: true,
          cliOnly: args["cli-only"],
          tools: args.tools,
          globalHooks: args["global-hooks"],
        });
        return args["dry-run"] ? { dryRun: summary(p) } : apply(p);
      },
      render,
    ),
});
