import { existsSync } from "node:fs";
import { join } from "node:path";
import { actorIdentity, SatiError } from "@sati/core";

/** Files or folders whose presence shows a project already uses an agent tool. */
const MARKERS: Record<string, readonly string[]> = {
  "claude-code": ["CLAUDE.md", ".claude"],
  codex: [".codex"],
  cursor: [".cursor", ".cursorrules"],
  "gemini-cli": ["GEMINI.md", ".gemini"],
  copilot: [".github/copilot-instructions.md"],
  windsurf: [".windsurf", ".windsurfrules"],
  cline: [".clinerules"],
  kiro: [".kiro"],
};

const TOOLS = Object.keys(MARKERS);

/**
 * Agent tools this project uses, from marker files in `root` plus the tool running this command
 * (if any).
 */
function detectTools(root: string, runningTool: string | null): string[] {
  const found = new Set<string>();
  for (const [tool, markers] of Object.entries(MARKERS)) {
    if (markers.some((m) => existsSync(join(root, m)))) found.add(tool);
  }
  if (runningTool) found.add(runningTool);
  return [...found].sort();
}

/** Detected tools plus the ones asked for with `--tools`. */
export function selectTools(root: string, asked: string | undefined): string[] {
  const running = actorIdentity({ env: process.env, worktree: root }).tool ?? null;
  const tools = new Set(detectTools(root, running));
  for (const t of (asked ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)) {
    if (!TOOLS.includes(t)) {
      throw new SatiError("USAGE", `Unknown tool "${t}".`, {
        hint: `Use any of: ${TOOLS.join(", ")}.`,
      });
    }
    tools.add(t);
  }
  return [...tools].sort();
}
