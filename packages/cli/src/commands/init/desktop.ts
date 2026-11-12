import { existsSync } from "node:fs";
import { basename } from "node:path";
import { CLI_NAME, SatiError } from "@sati/core";
import { locateDb } from "@sati/store-sqlite";

/** Where Claude Desktop keeps its config, for the hint under the entry. */
const DESKTOP_CONFIG =
  process.platform === "win32"
    ? "%APPDATA%\\Claude\\claude_desktop_config.json"
    : process.platform === "darwin"
      ? "~/Library/Application Support/Claude/claude_desktop_config.json"
      : "~/.config/Claude/claude_desktop_config.json";

export interface DesktopEntry {
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

/** The text `init --desktop` prints for a desktop entry. */
export function desktopText(r: DesktopEntry): string {
  return [
    `Add this to ${DESKTOP_CONFIG} (merge it into "mcpServers" if the file has one),`,
    "then restart Claude Desktop. Nothing was written.",
    "",
    JSON.stringify(r.desktop, null, 2),
  ].join("\n");
}
