import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { CLI_NAME, CONFIG_DIR, type Mode, SatiError } from "@sati/core";
import { isLocalInstall, localBin, runHint } from "./install.js";
import type { FileChange, PlannedFile, ReadFile } from "./integrations.js";

/** A repo-relative path for output, with `/` on every platform so `--json` reads the same. */
export const shownPath = (root: string, abs: string) => relative(root, abs).split(sep).join("/");

/** Marks a file as ours, so a later `init` may update it. Foreign hooks are never replaced. */
const OWNER = `# Installed by \`${CLI_NAME} init\``;
/** Our block inside a hook file someone else owns, such as a husky hook. */
const BEGIN = `# >>> ${CLI_NAME}`;
const END = `# <<< ${CLI_NAME}`;

/** Quotes one word for sh. */
const sh = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * How hooks and the merge driver start this sati: the absolute path of the running binary,
 * recorded at init, so a repo cannot swap in another `sati` through PATH. A script that is not
 * executable on its own is run with the current node. A project install records its
 * `node_modules/.bin` link instead, which still works after the package is upgraded.
 */
export function selfCommand(root: string): string[] {
  if (isLocalInstall(root)) return [localBin(root)];
  const arg = process.argv[1];
  if (!arg) throw new SatiError("INTERNAL", "Cannot tell where the sati binary is.");
  const script = resolve(arg);
  try {
    accessSync(script, constants.X_OK);
    return [script];
  } catch {
    return [process.execPath, script];
  }
}

const UPGRADE = `Run \`${CLI_NAME} init --upgrade\` from the new install.`;

/** A hook runner in `<git-common-dir>/sati/hooks/`. Only this file holds the binary's path. */
function runner(self: string[], purpose: string, body: string): string {
  const bin = self[self.length - 1] ?? "";
  return `#!/bin/sh
${OWNER}: ${purpose}
# Rewritten by \`${CLI_NAME} init --upgrade\`; do not edit.
${CLI_NAME}() { ${self.map(sh).join(" ")} "$@"; }
if [ ! -e ${sh(bin)} ]; then
  echo ${sh(`${CLI_NAME} is no longer at ${bin}, so its git hooks did not run. ${UPGRADE}`)} >&2
  exit 0
fi
${body}
`;
}

const GUARD = `# Override the guard once with SATI_GUARD=off (logged).
${CLI_NAME} guard --staged || exit $?`;
const IMPORT = `${CLI_NAME} sync import --quiet`;
// origin/HEAD names the remote's default branch; origin/main is the fallback. With neither, say
// so instead of letting every push go unguarded without a word.
const PUSH = `base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
[ -n "$base" ] || base=origin/main
if git rev-parse --verify --quiet "$base" >/dev/null 2>&1; then
  ${CLI_NAME} guard --range "$base...HEAD" || exit $?
else
  echo ${sh(`${CLI_NAME}: no origin/HEAD or origin/main to compare with, so this push was not guarded.`)} >&2
fi`;

/** The runners for each mode. Stealth commits nothing, so it only guards. */
function runners(mode: Mode, self: string[]): Record<string, string> {
  const push = runner(self, "checks the commits being pushed against shipped features.", PUSH);
  if (mode === "stealth") {
    return {
      "pre-commit": runner(self, "blocks commits that delete or gut a shipped feature.", GUARD),
      "pre-push": push,
    };
  }
  const load = runner(self, "loads teammates' records from .sati/ after git changes them.", IMPORT);
  return {
    "pre-commit": runner(
      self,
      "guards shipped features, then commits the .sati/ snapshot.",
      `${GUARD}\n${CLI_NAME} sync export >/dev/null && git add -A -- ${CONFIG_DIR}`,
    ),
    "post-merge": load,
    "post-checkout": load,
    "post-rewrite": load,
    "pre-push": push,
  };
}

/** The runner's path as hooks find it at run time; works from any worktree. */
const runnerPath = (name: string) =>
  `"$(git rev-parse --git-common-dir)/${CLI_NAME}/hooks/${name}"`;

/**
 * The block chained into a hook file. It holds no binary path, so it is safe in a committed husky
 * hook, and it does nothing on a machine without sati. Only pre-commit may stop git.
 */
function chainBlock(name: string): string {
  const stop = name === "pre-commit" || name === "pre-push" ? " || exit $?" : "";
  return `${BEGIN}: runs the ${CLI_NAME} hook. Managed by \`${CLI_NAME} init\`.
${CLI_NAME}_hook=${runnerPath(name)}
if [ -x "$${CLI_NAME}_hook" ]; then "$${CLI_NAME}_hook" "$@"${stop}; fi
${END}
`;
}

/** Shells that run our POSIX block; a hook with no `#!` line runs with sh too. */
const SHELLS = ["sh", "bash", "dash", "zsh", "ksh", "ash"];

/** The program a hook's `#!` line names (`#!/usr/bin/env node` → node); undefined without one. */
function interpreter(text: string): string | undefined {
  if (!text.startsWith("#!")) return undefined;
  const eol = text.indexOf("\n");
  const words = text
    .slice(2, eol < 0 ? undefined : eol)
    .trim()
    .split(/\s+/);
  const program = basename(words[0] ?? "");
  if (program !== "env") return program;
  // `env -S node --flag` or `env VAR=1 node`: the first word that is not an option or a variable.
  return basename(words.slice(1).find((w) => !w.startsWith("-") && !w.includes("=")) ?? "");
}

/** The interpreter of someone else's hook when it is not a shell, so our sh block would break it. */
function foreignInterpreter(existing: string | undefined): string | undefined {
  if (existing === undefined || existing.includes(BEGIN) || existing.includes(OWNER)) return;
  const program = interpreter(existing);
  return program !== undefined && !SHELLS.includes(program) ? program : undefined;
}

/** Puts our block into a hook file: replaces an old block, else goes right after the shebang. */
function chainInto(existing: string | undefined, name: string): string {
  const block = chainBlock(name);
  if (existing === undefined) return `#!/bin/sh\n${block}`;
  const start = existing.indexOf(BEGIN);
  const stop = existing.indexOf(END, start);
  if (start >= 0 && stop >= 0) {
    const after = existing.indexOf("\n", stop);
    return existing.slice(0, start) + block + (after < 0 ? "" : existing.slice(after + 1));
  }
  // A whole hook file written by an older `sati init` is ours to replace.
  if (existing.includes(OWNER)) return `#!/bin/sh\n${block}`;
  if (!existing.startsWith("#!")) return block + existing;
  const eol = existing.indexOf("\n");
  return eol < 0
    ? `${existing}\n${block}`
    : existing.slice(0, eol + 1) + block + existing.slice(eol + 1);
}

const LEFTHOOK_CONFIGS = ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"];
const LEFTHOOK_LOCAL = "lefthook-local.yml";

/** lefthook merges `lefthook-local.yml` into its config, so we chain there and leave its hooks. */
function lefthookLocal(names: string[]): string {
  const lines = [`${BEGIN}: runs the ${CLI_NAME} hooks. Managed by \`${CLI_NAME} init\`.`];
  for (const name of names) {
    const run = `${CLI_NAME}_hook=${runnerPath(name)}; [ ! -x "$${CLI_NAME}_hook" ] || "$${CLI_NAME}_hook"`;
    lines.push(`${name}:`, "  commands:", `    ${CLI_NAME}:`, `      run: ${sh(run)}`);
  }
  lines.push(END);
  return `${lines.join("\n")}\n`;
}

export interface PlannedHook extends FileChange {
  abs: string;
  content: string;
  /** Why a hook was skipped, or what the user must do next. */
  note?: string;
  /** In a global `core.hooksPath` outside the repo, which every repo on the machine uses. */
  global?: boolean;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

const absFrom = (root: string, p: string) => (isAbsolute(p) ? p : resolve(root, p));

/**
 * True when `dir` comes from a `core.hooksPath` set outside this repo's own config (global,
 * system or `-c`) and lies outside the repo, so writing there changes every repo that uses it.
 */
function isGlobalHooksDir(root: string, dir: string): boolean {
  let scope: string;
  try {
    scope = git(root, "config", "--show-scope", "--get", "core.hooksPath").split("\t")[0] ?? "";
  } catch {
    return false; // git exits 1 when the key is unset
  }
  if (scope === "local" || scope === "worktree") return false;
  const rel = relative(root, dir);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function planFile(root: string, abs: string, content: string): PlannedHook {
  const existing = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  const action = existing === undefined ? "create" : existing === content ? "keep" : "update";
  return { path: shownPath(root, abs), abs, action, content };
}

/**
 * The git hooks for this repo. The runners live in `<git-common-dir>/sati/hooks/`. Each hook git
 * calls (in `core.hooksPath`, husky's folder or `.git/hooks`) gets a short marked block that
 * calls its runner; the rest of an existing hook is kept as is. lefthook gets
 * `lefthook-local.yml`. Stealth mode never touches a file inside the working tree. A global
 * `core.hooksPath` outside the repo is shared by every repo on the machine, so it is only written
 * with `globalHooks`; a hook in another language than sh is reported, never edited.
 */
export function planHooks(
  root: string,
  mode: Mode,
  self: string[],
  globalHooks = false,
): PlannedHook[] {
  if (mode === "standalone") return [];
  const common = absFrom(root, git(root, "rev-parse", "--git-common-dir"));
  const scripts = runners(mode, self);
  const planned = Object.entries(scripts).map(([name, content]) =>
    planFile(root, resolve(common, CLI_NAME, "hooks", name), content),
  );
  const inTree = (abs: string) => {
    const rel = relative(root, abs);
    return (
      !rel.startsWith(`..${sep}`) && rel !== ".." && !`${abs}${sep}`.startsWith(`${common}${sep}`)
    );
  };

  const lefthook = LEFTHOOK_CONFIGS.find((f) => existsSync(resolve(root, f)));
  if (lefthook) {
    const abs = resolve(root, LEFTHOOK_LOCAL);
    const content = lefthookLocal(Object.keys(scripts));
    const existing = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    const base = { path: LEFTHOOK_LOCAL, abs, content };
    if (mode === "stealth") {
      planned.push({ ...base, action: "skip", note: `stealth mode leaves ${lefthook} alone` });
    } else if (existing === undefined || existing === content || existing.startsWith(BEGIN)) {
      const action = existing === undefined ? "create" : existing === content ? "keep" : "update";
      planned.push({ ...base, action, note: "run `lefthook install` to install the new hooks" });
    } else {
      planned.push({
        ...base,
        action: "skip",
        note: `${LEFTHOOK_LOCAL} exists; add these hooks to it yourself:\n${content}`,
      });
    }
    return planned;
  }

  // husky 9 points core.hooksPath at `.husky/_`, whose files it regenerates; ours go in `.husky/`.
  let dir = absFrom(root, git(root, "rev-parse", "--git-path", "hooks"));
  if (relative(root, dir) === `.husky${sep}_`) dir = resolve(root, ".husky");
  const global = isGlobalHooksDir(root, dir);
  const slashed = (abs: string) => abs.split(sep).join("/");
  for (const name of Object.keys(scripts)) {
    const abs = resolve(dir, name);
    const existing = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    const program = foreignInterpreter(existing);
    let hook: PlannedHook;
    if (global && !globalHooks) {
      hook = { path: "", abs, action: "skip", content: existing ?? "" };
    } else if (program !== undefined) {
      const stop = name === "pre-commit" || name === "pre-push" ? ", and stop when it fails" : "";
      hook = {
        path: "",
        abs,
        action: "skip",
        content: existing ?? "",
        note: `this hook runs with ${program}, not sh, so ${CLI_NAME} left it unchanged. Have it run ${shownPath(root, resolve(common, CLI_NAME, "hooks", name))} with the same arguments${stop}`,
      };
    } else {
      hook = planFile(root, abs, chainInto(existing, name));
    }
    hook.path = global ? slashed(abs) : shownPath(root, abs);
    if (global) hook.global = true;
    if (mode === "stealth" && inTree(abs) && hook.action !== "keep" && hook.action !== "skip") {
      hook.action = "skip";
      hook.note = "stealth mode does not edit hooks inside the working tree";
    }
    planned.push(hook);
  }
  const first = planned.find((h) => h.global);
  if (first && !globalHooks) {
    first.note = `git uses the global core.hooksPath ${slashed(dir)} for every repo on this machine, so ${CLI_NAME} did not write there and its git hooks will not run in this repo. To chain them into that folder (they do nothing in repos without ${CLI_NAME}), run \`${runHint(root, "init --upgrade --global-hooks")}\``;
  }
  return planned;
}

const ATTRIBUTE = `${CONFIG_DIR}/**/*.json merge=${CLI_NAME} linguist-generated`;
/** The line older versions wrote; it is replaced, not duplicated. */
const OLD_ATTRIBUTE = `${CONFIG_DIR}/**/*.json merge=${CLI_NAME}`;

/**
 * `.gitattributes` routes the snapshot files to the merge driver and marks them generated, so PR
 * diffs collapse them. Other lines are kept.
 */
export function planGitAttributes(read: ReadFile): PlannedFile {
  const path = ".gitattributes";
  const existing = read(path);
  if (existing === undefined) return { path, action: "create", content: `${ATTRIBUTE}\n` };
  const lines = existing.split("\n");
  if (lines.some((l) => l.trim() === ATTRIBUTE)) return { path, action: "keep", content: existing };
  const old = lines.findIndex((l) => l.trim() === OLD_ATTRIBUTE);
  if (old >= 0) {
    lines[old] = ATTRIBUTE;
    return { path, action: "update", content: lines.join("\n") };
  }
  const gap = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return { path, action: "update", content: `${existing}${gap}${ATTRIBUTE}\n` };
}

export interface PlannedGitConfig extends FileChange {
  entries: [key: string, value: string][];
}

/** git config is local to each clone, so init registers the driver in `.git/config`. */
export function planMergeDriver(root: string, self: string[]): PlannedGitConfig {
  const common = absFrom(root, git(root, "rev-parse", "--git-common-dir"));
  const path = shownPath(root, resolve(common, "config"));
  const entries: [string, string][] = [
    [`merge.${CLI_NAME}.name`, `${CLI_NAME} record merge`],
    [`merge.${CLI_NAME}.driver`, `${self.map(sh).join(" ")} merge-driver %O %A %B`],
  ];
  const current = (key: string) => {
    try {
      return git(root, "config", "--local", "--get", key);
    } catch {
      return undefined; // git exits 1 when the key is unset
    }
  };
  const values = entries.map(([key]) => current(key));
  const action = values.every((v, i) => v === entries[i]?.[1])
    ? "keep"
    : values.every((v) => v === undefined)
      ? "create"
      : "update";
  return { path, action, entries };
}

export function applyMergeDriver(root: string, plan: PlannedGitConfig): void {
  if (plan.action === "keep" || plan.action === "skip") return;
  for (const [key, value] of plan.entries) {
    execFileSync("git", ["config", "--local", key, value], { cwd: root, stdio: "ignore" });
  }
}
