import {
  CLI_NAME,
  type InboxMentionRow,
  type InboxOutput,
  type InboxTaskRow,
  inbox,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { handle, row } from "../render.js";
import { execute } from "../runtime.js";
import { bold, dim, term, truncate, when } from "../term.js";

/** Stored text on one line: a comment or a question may hold line breaks. */
const flat = (text: string) => text.replace(/\s+/gu, " ").trim();

/** What a task row adds under its title: the question, the reason, or what was done. */
function detail(t: InboxTaskRow): string {
  if (t.asks) {
    const verb = t.asks.kind === "permission" ? "needs your permission" : "asks";
    return `${t.asks.by} ${verb}: ${flat(t.asks.text)}`;
  }
  if (t.status === "blocked") return `blocked: ${flat(t.blockedReason ?? "No reason given.")}`;
  if (t.summary) {
    const files = t.files ? ` (${t.files} file${t.files === 1 ? "" : "s"})` : "";
    return `${t.completedBy ? `${t.completedBy}: ` : ""}${flat(t.summary)}${files}`;
  }
  return "";
}

const mentionLine = (m: InboxMentionRow) => `${m.by}, ${when(m.createdAt)}: ${flat(m.body)}`;

/** The day `due` runs to, as "Sun 8 Nov". Built from the parts: the day has no time zone. */
function dayName(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** One line per item, each starting with its section, so `grep` and `cut` can take one. */
function compact(out: InboxOutput): string {
  const task = (section: string) => (t: InboxTaskRow) => {
    const more = detail(t);
    return `${section}  ${row(t)}${more ? `  ${more}` : ""}`;
  };
  const lines = [
    ...out.needsAnswer.map(task("needs")),
    ...out.mentions.map(
      (m) => `mention  ${handle(m.on)}  ${m.onTitle || "A record"}  ${mentionLine(m)}`,
    ),
    ...out.approval.map(task("approve")),
    ...out.assigned.map(task("assigned")),
    ...out.due.map(task("due")),
  ];
  return lines.length ? lines.join("\n") : "Nothing waits for you.";
}

/** The sections of the board's My work page, in its order and with its headings. */
function sections(out: InboxOutput): string {
  const max = Math.min(term().width, 120);
  const under = (text: string) => (text ? `\n      ${dim(truncate(text, max - 6))}` : "");
  const tasks = (items: readonly InboxTaskRow[]) =>
    items.map((t) => `  ${row(t)}${under(detail(t))}`);
  const block = (title: string, lines: string[], empty?: string) =>
    lines.length
      ? [`${bold(title)} ${dim(`· ${lines.length}`)}`, ...lines, ""]
      : empty
        ? [bold(title), `  ${dim(empty)}`, ""]
        : [];
  const head =
    out.count > 0
      ? `${bold(`Inbox for ${out.for.name}`)}  ${dim(`· ${out.count} need${out.count === 1 ? "s" : ""} you`)}`
      : bold(`Inbox for ${out.for.name}`);
  const lines = [
    head,
    "",
    ...block("Needs you", tasks(out.needsAnswer)),
    ...block(
      "Mentions",
      out.mentions.map(
        (m) => `  ${handle(m.on)}  ${m.onTitle || "A record"}${under(mentionLine(m))}`,
      ),
    ),
    ...block("Waiting for your approval", tasks(out.approval), "Nothing to approve."),
    ...block("Assigned to you", tasks(out.assigned), "Nothing is assigned to you."),
    ...block(
      `Due by ${dayName(out.end)}`,
      tasks(out.due),
      out.approval.length + out.assigned.length > 0
        ? "Nothing else is due this week."
        : "Nothing is due this week.",
    ),
  ];
  const hints = [
    out.approval.length ? `Approve: ${CLI_NAME} task update <id> --status done` : "",
    out.mentions.length ? `Reply: ${CLI_NAME} comment add <id> "…"` : "",
    out.needsAnswer.some((t) => t.asks) ? `Answered: ${CLI_NAME} wait --clear --task <id>` : "",
  ].filter(Boolean);
  return [...lines, ...hints.map(dim)].join("\n").trimEnd();
}

export default defineCommand({
  meta: {
    name: "inbox",
    description: "What waits for you: questions, mentions, approvals, assigned and due tasks",
  },
  args: {
    for: {
      type: "string",
      description: "Another actor's inbox, by name or id (default: yours)",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      ({ ctx }) => inbox(ctx, args.for === undefined ? {} : { for: args.for }),
      (out: InboxOutput) => (term().rich ? sections(out) : compact(out)),
    ),
});
