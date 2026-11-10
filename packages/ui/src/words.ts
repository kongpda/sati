import { ApiError, COLUMNS, SHORT_DAY } from "./api.js";

/*
 * The words people read in the board. The CLI and MCP keep their own terms (`in_progress`,
 * claim, lease, lock); docs/guide/glossary.md maps one to the other. Keep the two in step.
 */

/** Task statuses as people say them. The values sent to the server stay the same. */
const STATUS_WORDS: Record<string, string> = Object.fromEntries(COLUMNS);

export const statusWord = (status: string): string => STATUS_WORDS[status] ?? status;

/** A one-word value as a label: "high" → "High", "building" → "Building". */
export const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** What each kind of record is called in a sentence ("deleted the note"). */
const KIND_WORDS: Record<string, string> = {
  task: "task",
  note: "note",
  decision: "decision",
  feature: "feature",
  milestone: "milestone",
  lock: "file reservation",
  context: "card",
  actor: "profile",
  project: "project",
};

const kindWord = (entity: string) => KIND_WORDS[entity] ?? entity;

/** What each kind of record is called on a badge: search hits, recall answers. */
const KIND_LABELS: Record<string, string> = {
  task: "Task",
  note: "Note",
  decision: "Decision",
  feature: "Feature",
  card: "Card",
  context: "Card",
};

export const kindLabel = (entity: string): string => KIND_LABELS[entity] ?? capital(entity);

function changedTo(diff: Record<string, unknown>, key: string): unknown {
  const change = diff[key];
  return change !== null && typeof change === "object" && "to" in change
    ? (change as { to: unknown }).to
    : undefined;
}

/** One activity row as a sentence after the person's name: "moved the task to Done". */
export function activityWords(verb: string, entity: string, diff: Record<string, unknown>) {
  const kind = kindWord(entity);
  const status = changedTo(diff, "status");
  const moved =
    typeof status === "string" ? ` to ${entity === "task" ? statusWord(status) : status}` : "";
  if (entity === "actor" && verb === "create") return "joined the project";
  if (entity === "project" && verb === "update") return "changed the project settings";
  switch (verb) {
    case "create":
      return `added the ${kind}`;
    case "delete":
      return `deleted the ${kind}`;
    case "complete":
      return status === "review"
        ? `finished the ${kind} and sent it for approval`
        : `finished the ${kind}`;
    case "claim":
      return `started working on the ${kind}`;
    case "release":
      return `stopped working on the ${kind}`;
    case "status":
      return `moved the ${kind}${moved}`;
    case "import":
      return `brought in the ${kind} from a teammate's copy`;
    case "init":
      return "set up the project";
    case "guard":
      return `was warned before changing the ${kind}`;
    default:
      // A restore is an update that clears deletedAt.
      if ("deletedAt" in diff && changedTo(diff, "deletedAt") === null)
        return `restored the ${kind}`;
      return `changed the ${kind}`;
  }
}

// `toLocaleString` with options builds a new formatter on every call. On a large board that was
// a third of each scroll frame (every card's tooltip), so these are built once, in the reader's
// own locale.
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** A clock time in the reader's zone and their own 12 or 24 hour style; the day if not today. */
export function untilTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = CLOCK.format(at);
  if (at.toDateString() === now.toDateString()) return time;
  return `${SHORT_DAY.format(at)} ${time}`;
}

/** The full local date and time, for tooltips; never the raw ISO string. */
export function fullTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return FULL.format(at);
}

/** A calendar day (YYYY-MM-DD, no zone) as the reader writes dates, read as a local day. */
export function dayWords(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return DAY.format(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1));
}

/**
 * A refused save in words a person can act on. The server's messages are written for agents
 * (record versions, fencing tokens, CLI commands), so the common ones are put plainly here;
 * any other message is shown as sent, and a hint naming a command is left out.
 */
export function plainError(err: unknown): string {
  if (!(err instanceof ApiError)) return "That change did not save. Try again.";
  if (err.code === "CONFLICT" && /is at version/u.test(err.message)) {
    return "Someone saved a change to this since you opened it, so yours was not saved. Look at the new version and try again.";
  }
  if (err.code === "CONFLICT" && /claimed|fencing/u.test(err.message)) {
    return "Someone is working on this task. Take it over or release it first, then try again.";
  }
  if (err.code === "CONFLICT" && /locked/u.test(err.message)) {
    return "Someone has reserved these files for their edits. Try again when they are done.";
  }
  const hint = err.hint && !err.hint.includes("`") ? ` ${err.hint}` : "";
  return `${err.message}${hint}`;
}
