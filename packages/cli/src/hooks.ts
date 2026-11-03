import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { CLI_NAME, type Mode } from "@brain/core";
import type { FileChange } from "./integrations.js";

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

const GUARD = `# Override the guard once with BRAIN_GUARD=off (logged).
${CLI_NAME} guard --staged || exit $?`;

const IMPORT = script(
  "loads teammates' records from .brain/ after git changes the files.",
  `exec ${CLI_NAME} sync import`,
);

/** The hooks for each mode. Stealth commits nothing, so it only guards. */
function hookScripts(mode: Mode): Record<string, string> {
  if (mode === "stealth") {
    return { "pre-commit": script("blocks commits that delete or gut a shipped feature.", GUARD) };
  }
  return {
    "pre-commit": script(
      "guards shipped features, then commits the .brain/ snapshot.",
      `${GUARD}
${CLI_NAME} sync export >/dev/null && exec git add -A -- .brain`,
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
