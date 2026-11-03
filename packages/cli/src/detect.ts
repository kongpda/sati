import { existsSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Agent tools this project uses, from marker files in `root` plus the tool running this command
 * (if any). Phase 1 only reports them; Phase 2 writes their configs.
 */
export function detectTools(
  root: string,
  runningTool: string | null,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const found = new Set<string>();
  for (const [tool, markers] of Object.entries(MARKERS)) {
    if (markers.some((m) => exists(join(root, m)))) found.add(tool);
  }
  if (runningTool) found.add(runningTool);
  return [...found].sort();
}
