import { CLI_NAME } from "@sati/core/name";
import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { main } from "./main.js";

// Subcommands load on demand so `sati --version` and `--help` stay fast.
const lazy = (load: () => Promise<{ default: unknown }>) => () =>
  load().then((m) => m.default as ReturnType<typeof defineCommand>);

const root = defineCommand({
  meta: { name: CLI_NAME, version: pkg.version, description: pkg.description },
  subCommands: {
    init: lazy(() => import("./commands/init.js")),
    brief: lazy(() => import("./commands/brief.js")),
    task: lazy(() => import("./commands/task.js")),
    feature: lazy(() => import("./commands/feature.js")),
    note: lazy(() => import("./commands/note.js")),
    context: lazy(() => import("./commands/context.js")),
    decision: lazy(() => import("./commands/decision.js")),
    lock: lazy(() => import("./commands/lock.js")),
    guard: lazy(() => import("./commands/guard.js")),
    search: lazy(() => import("./commands/search.js")),
    nudge: lazy(() => import("./commands/nudge.js")),
    rules: lazy(() => import("./commands/rules.js")),
    sync: lazy(() => import("./commands/sync.js")),
    "merge-driver": lazy(() => import("./commands/merge-driver.js")),
    mcp: lazy(() => import("./commands/mcp.js")),
  },
});

await main(root);
