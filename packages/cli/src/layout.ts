import { HIDDEN_FLAGS } from "./flags.js";
import type { HelpLayout } from "./help.js";

/** How the root help lists the commands, and what is kept out of it. */
export const layout: HelpLayout = {
  groups: {
    Start: ["init", "upgrade", "brief", "inbox", "next", "doctor"],
    Work: ["task", "feature", "milestone", "plan", "template", "handoff", "wait"],
    Memory: ["note", "comment", "decision", "card", "recall", "search"],
    "Work together": ["lock", "guard", "review", "scan"],
    History: ["activity", "changes", "undo"],
    Project: ["settings", "projects", "ui", "rules", "sync", "export", "import", "completion"],
    "Run by tools": ["mcp", "serve", "nudge", "merge-driver"],
  },
  aliases: { context: "card", app: "ui" },
  hidden: [],
  hiddenFlags: HIDDEN_FLAGS,
};
