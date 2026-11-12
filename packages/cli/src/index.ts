import { CLI_NAME } from "@sati/core/name";
import { type CommandDef, defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };
import { main } from "./main.js";
import { VERSION } from "./version.js";

// The store needs node:sqlite as in Node 24.15 (ADR 0003). Commands load lazily, so this check
// runs before anything imports it. `engines.node` is `>=major.minor`.
const [needMajor = 0, needMinor = 0] = pkg.engines.node.slice(2).split(".").map(Number);
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < needMajor || (major === needMajor && minor < needMinor)) {
  process.stderr.write(
    `error: ${CLI_NAME} needs Node.js ${needMajor}.${needMinor} or newer; this is ${process.version}.\n` +
      `hint: Install Node.js ${needMajor} LTS or newer from https://nodejs.org, then run ${CLI_NAME} again.\n`,
  );
  process.exit(1);
}

// Subcommands load on demand so `sati --version` and `--help` stay fast.
const lazy = (load: () => Promise<{ default: unknown }>) => () =>
  load().then((m) => m.default as ReturnType<typeof defineCommand>);

const root: CommandDef = defineCommand({
  meta: { name: CLI_NAME, version: VERSION, description: pkg.description },
  subCommands: {
    init: lazy(() => import("./commands/init.js")),
    upgrade: lazy(() => import("./commands/upgrade.js")),
    brief: lazy(() => import("./commands/brief.js")),
    inbox: lazy(() => import("./commands/inbox.js")),
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
    app: lazy(() => import("./commands/ui.js")),
    next: lazy(() => import("./commands/next.js")),
    handoff: lazy(() => import("./commands/handoff.js")),
    wait: lazy(() => import("./commands/wait.js")),
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
    completion: () =>
      import("./commands/completion.js").then((m) => m.completionCommand(() => root)),
  },
});

await main(root, {
  groups: {
    Start: ["init", "upgrade", "brief", "next", "doctor"],
    Work: ["task", "feature", "milestone", "plan", "template", "handoff", "wait"],
    Memory: ["note", "comment", "decision", "card", "recall", "search"],
    "Work together": ["lock", "guard", "review", "scan"],
    History: ["activity", "changes", "undo"],
    Project: ["settings", "projects", "ui", "rules", "sync", "export", "import", "completion"],
    "Run by tools": ["mcp", "serve", "nudge", "merge-driver"],
  },
  aliases: { context: "card", app: "ui" },
});
