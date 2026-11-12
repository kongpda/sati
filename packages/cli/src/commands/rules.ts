import { readSettings } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { selectTools } from "../detect.js";
import { isLocalInstall } from "../install.js";
import { type FileChange, planAgentFiles, warnIfNotOnPath, writePlanned } from "../integrations.js";
import { execute } from "../runtime.js";

const sync = defineCommand({
  meta: {
    name: "sync",
    description: "Rewrite the managed rules blocks and agent configs from the current template",
  },
  args: {
    tools: {
      type: "string",
      description: "Also set up these agent tools, comma-separated (e.g. claude-code,codex)",
    },
    "cli-only": {
      type: "boolean",
      description:
        "Write the rules as commands, for agents with no MCP client, and add no MCP configs. Kept by later runs; --no-cli-only goes back to the MCP tool names",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ project, location }) => {
        const tools = selectTools(location.root, args.tools);
        const { files, exclude } = planAgentFiles(
          location.root,
          project.mode,
          location.path,
          readSettings(project.settings).kind,
          tools,
          args["cli-only"],
        );
        writePlanned(location.root, files, exclude);
        warnIfNotOnPath(tools, isLocalInstall(location.root));
        return files.map(({ path, action }): FileChange => ({ path, action }));
      },
      (files) => {
        const changed = files.filter((f) => f.action === "create" || f.action === "update");
        const lines = files.map((f) => `  ${f.action.padEnd(7)} ${f.path}`);
        return [
          changed.length ? `Synced ${changed.length} file(s).` : "Everything is up to date.",
          ...lines,
        ].join("\n");
      },
    ),
});

export default defineCommand({
  meta: { name: "rules", description: "Manage the rules blocks in agent rules files" },
  subCommands: { sync },
});
