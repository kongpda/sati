import { CLI_NAME } from "@brain/core/name";
import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { main } from "./main.js";

// Subcommands load on demand so `brain --version` and `--help` stay fast.
const lazy = (load: () => Promise<{ default: unknown }>) => () =>
  load().then((m) => m.default as ReturnType<typeof defineCommand>);

const root = defineCommand({
  meta: { name: CLI_NAME, version: pkg.version, description: pkg.description },
  subCommands: {
    init: lazy(() => import("./commands/init.js")),
    task: lazy(() => import("./commands/task.js")),
    feature: lazy(() => import("./commands/feature.js")),
    note: lazy(() => import("./commands/note.js")),
    decision: lazy(() => import("./commands/decision.js")),
    search: lazy(() => import("./commands/search.js")),
    mcp: lazy(() => import("./commands/mcp.js")),
  },
});

await main(root);
