import { defineCommand } from "citty";
import { json } from "../args.js";
import { selectTools } from "../detect.js";
import {
  excludeFileFor,
  type FileChange,
  fileReader,
  planIntegrations,
  readExcluded,
  writePlanned,
} from "../integrations.js";
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
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ project, location }) => {
        const stealth = project.mode === "stealth";
        const exclude = stealth ? excludeFileFor(location.path) : undefined;
        const excluded = exclude ? readExcluded(exclude) : new Set<string>();
        const files = planIntegrations(
          selectTools(location.root, args.tools),
          project.mode,
          fileReader(location.root),
          (path) => path === "CLAUDE.local.md" || excluded.has(path),
        );
        writePlanned(location.root, files, exclude);
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
