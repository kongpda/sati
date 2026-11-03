import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { CLI_NAME, CONFIG_DIR, type Mode } from "@sati/core";
import type { FileChange, PlannedFile, ReadFile } from "./integrations.js";

/** Marks a hook as ours, so a later `init` may update it. Foreign hooks are never touched. */
const OWNER = `# Installed by \`${CLI_NAME} init\``;

function script(purpose: string, body: string): string {
  return `#!/bin/sh
${OWNER}: ${purpose}
if ! command -v ${CLI_NAME} >/dev/null 2>&1; then
  echo "${CLI_NAME} is not on PATH, so this ${CLI_NAME} hook did not run." >&2
  exit 0
fi
${body}
`;
}

const GUARD = `# Override the guard once with SATI_GUARD=off (logged).
${CLI_NAME} guard --staged || exit $?`;

const IMPORT = script(
  "loads teammates' records from .sati/ after git changes the files.",
  `exec ${CLI_NAME} sync import`,
);

/** The hooks for each mode. Stealth commits nothing, so it only guards. */
function hookScripts(mode: Mode): Record<string, string> {
  if (mode === "stealth") {
    return { "pre-commit": script("blocks commits that delete or gut a shipped feature.", GUARD) };
  }
  return {
    "pre-commit": script(
      "guards shipped features, then commits the .sati/ snapshot.",
      `${GUARD}
${CLI_NAME} sync export >/dev/null && exec git add -A -- .sati`,
    ),
    "post-merge": IMPORT,
    "post-checkout": IMPORT,
    "post-rewrite": IMPORT,
  };
}

export interface PlannedHook extends FileChange {
  abs: string;
  content: string;
}

/**
 * The git hooks for this repo. A missing hook is created and an outdated one of ours is updated.
 * Any other existing hook is skipped, never overwritten.
 */
export function planHooks(root: string, mode: Mode): PlannedHook[] {
  if (mode === "standalone") return [];
  const dir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const hooksDir = isAbsolute(dir) ? dir : resolve(root, dir);
  return Object.entries(hookScripts(mode)).map(([name, content]) => {
    const abs = resolve(hooksDir, name);
    const existing = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    const action =
      existing === undefined
        ? "create"
        : existing === content
          ? "keep"
          : existing.includes(OWNER)
            ? "update"
            : "skip";
    return { path: relative(root, abs), abs, action, content };
  });
}

const ATTRIBUTE = `${CONFIG_DIR}/**/*.json merge=${CLI_NAME}`;

/** `.gitattributes` routes the snapshot files to the merge driver; other lines are kept. */
export function planGitAttributes(read: ReadFile): PlannedFile {
  const path = ".gitattributes";
  const existing = read(path);
  if (existing === undefined) return { path, action: "create", content: `${ATTRIBUTE}\n` };
  if (existing.split("\n").some((l) => l.trim() === ATTRIBUTE)) {
    return { path, action: "keep", content: existing };
  }
  const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
  return { path, action: "update", content: `${existing}${sep}${ATTRIBUTE}\n` };
}

export interface PlannedGitConfig extends FileChange {
  entries: [key: string, value: string][];
}

/** git config is local to each clone, so init registers the driver in `.git/config`. */
export function planMergeDriver(root: string): PlannedGitConfig {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const common = git("rev-parse", "--git-common-dir").trim();
  const path = relative(
    root,
    resolve(isAbsolute(common) ? common : resolve(root, common), "config"),
  );
  const entries: [string, string][] = [
    [`merge.${CLI_NAME}.name`, `${CLI_NAME} record merge`],
    [`merge.${CLI_NAME}.driver`, `${CLI_NAME} merge-driver %O %A %B`],
  ];
  const current = (key: string) => {
    try {
      return git("config", "--local", "--get", key).trim();
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
