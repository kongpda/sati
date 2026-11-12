import { HIDDEN_FLAGS } from "./flags.js";
import type { HelpLayout } from "./help.js";

/** How the root help lists the commands, and what is kept out of it. */
export const layout: HelpLayout = {
  groups: {
    Start: ["init", "upgrade", "brief", "inbox", "next", "completion"],
    Work: ["task", "feature", "milestone", "plan", "template", "handoff", "wait"],
    Memory: ["note", "comment", "decision", "card", "recall", "search"],
    "Work together": ["lock", "guard", "review", "scan"],
    History: ["activity", "changes", "undo"],
    Project: ["settings", "projects", "ui", "sync", "doctor"],
    "Run by tools": ["mcp", "serve", "nudge", "merge-driver"],
  },
  aliases: { context: "card" },
  hidden: ["rules", "export", "import", "app"],
  hiddenFlags: HIDDEN_FLAGS,
};
