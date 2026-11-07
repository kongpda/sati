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
    comment: lazy(() => import("./commands/comment.js")),
    context: lazy(() => import("./commands/context.js")),
    card: lazy(() => import("./commands/context.js")),
    recall: lazy(() => import("./commands/recall.js")),
    decision: lazy(() => import("./commands/decision.js")),
    lock: lazy(() => import("./commands/lock.js")),
    guard: lazy(() => import("./commands/guard.js")),
    search: lazy(() => import("./commands/search.js")),
    nudge: lazy(() => import("./commands/nudge.js")),
    rules: lazy(() => import("./commands/rules.js")),
    sync: lazy(() => import("./commands/sync.js")),
    "merge-driver": lazy(() => import("./commands/merge-driver.js")),
    mcp: lazy(() => import("./commands/mcp.js")),
    ui: lazy(() => import("./commands/ui.js")),
    next: lazy(() => import("./commands/next.js")),
    handoff: lazy(() => import("./commands/handoff.js")),
    milestone: lazy(() => import("./commands/milestone.js")),
    plan: lazy(() => import("./commands/plan.js")),
    template: lazy(() => import("./commands/template.js")),
    activity: lazy(() => import("./commands/activity.js")),
    changes: lazy(() => import("./commands/changes.js")),
    undo: lazy(() => import("./commands/undo.js")),
    settings: lazy(() => import("./commands/settings.js")),
    doctor: lazy(() => import("./commands/doctor.js")),
    projects: lazy(() => import("./commands/projects.js")),
    // The same commands as `sync export` and `sync import`.
    export: lazy(() => import("./commands/sync.js").then((m) => ({ default: m.exportCmd }))),
    import: lazy(() => import("./commands/sync.js").then((m) => ({ default: m.importCmd }))),
    review: lazy(() => import("./commands/review.js")),
    scan: lazy(() => import("./commands/scan.js")),
    serve: lazy(() => import("./commands/serve.js")),
  },
});

await main(root);
