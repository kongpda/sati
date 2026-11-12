/*
 * What waits for one person or agent. The board's My work page, `sati inbox` and the MCP `inbox`
 * tool all call this file, so they cannot disagree. The board bundles it for the browser: keep it
 * free of runtime imports.
 */

/** The fields of a task the lists are built from. A stored task and the board's task both fit. */
export interface InboxTask {
  id: string;
  status: string;
  priority: string;
  dueDate?: string | null | undefined;
  assigneeIds?: readonly string[] | undefined;
  claim?: { leaseUntil: string; waiting?: { since: string } | undefined } | null | undefined;
}

/** The fields of a note that say whether it is a comment that calls someone. */
export interface InboxNote {
  id: string;
  body: string;
  tags: readonly string[];
  links: readonly string[];
  createdAt: string;
  createdBy: string;
  deletedAt?: string | null | undefined;
}

/** How an actor is called in a comment. */
export interface InboxActor {
  id: string;
  name: string;
  displayName?: string | undefined;
}

/** The tag of a note that is a comment on a task, note or decision. */
export const COMMENT_TAG = "comment";

const CLOSED = new Set(["done", "cancelled"]);

/** A mention older than this no longer asks for attention. */
const MENTION_DAYS = 14;

/** The last day of this week (Sunday) in the reader's time zone, as YYYY-MM-DD. */
export function weekEnd(now: Date): string {
  const days = (7 - now.getDay()) % 7;
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
}

/** What the holder of a task waits on a person for, while its claim still runs. */
export function waitingOn<W>(
  task: { claim?: { leaseUntil: string; waiting?: W | undefined } | null | undefined },
  now: number,
): W | undefined {
  const c = task.claim;
  return c?.waiting && Date.parse(c.leaseUntil) > now ? c.waiting : undefined;
}

/**
 * Comments that call `actor` by name (`@ann`, `@claude-code`), newest first: by the shown name,
 * its first word, or the user part of `user@worktree`. A mention is done once the actor comments
 * on the same record after it, so nothing is stored about what was read; one nobody answers
 * leaves after two weeks.
 */
export function mentionsOf<N extends InboxNote>(
  notes: readonly N[],
  actor: InboxActor,
  now: Date,
  /** Other actors that are the same one: every session of an agent is an actor of its own. */
  selves: ReadonlySet<string> = new Set(),
): N[] {
  const mine = (id: string) => id === actor.id || selves.has(id);
  const shown = actor.displayName ?? actor.name;
  const names = [shown, shown.split(/\s+/u)[0] ?? "", actor.name.split("@")[0] ?? ""]
    .filter((n) => n.length > 0)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  if (names.length === 0) return [];
  // Not inside a word or an email address: `x@ann.com` and `@annette` do not call Ann.
  const calls = new RegExp(`(?<![\\p{L}\\p{N}_.])@(?:${names.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
  const since = new Date(now.getTime() - MENTION_DAYS * 86_400_000).toISOString();
  // The board's notes carry no `deletedAt`: its server sends live records only.
  const comments = notes.filter((n) => n.tags.includes(COMMENT_TAG) && n.deletedAt == null);
  // The latest comment of the actor's own on each record.
  const answered = new Map<string, string>();
  for (const n of comments) {
    const on = n.links[0];
    if (on && mine(n.createdBy) && n.createdAt > (answered.get(on) ?? "")) {
      answered.set(on, n.createdAt);
    }
  }
  return comments
    .filter(
      (n) =>
        !mine(n.createdBy) &&
        n.createdAt >= since &&
        n.createdAt > (answered.get(n.links[0] ?? "") ?? "") &&
        calls.test(n.body),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

/** Due soonest first; undated last; then the higher priority. */
const RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
function byDue(a: InboxTask, b: InboxTask): number {
  const left = a.dueDate ?? "9999";
  const right = b.dueDate ?? "9999";
  if (left !== right) return left < right ? -1 : 1;
  return (RANK[a.priority] ?? 9) - (RANK[b.priority] ?? 9);
}

/**
 * The lists a person starts the day with. Each task shows once, in the first list it fits:
 * needs you (an agent asks a question or waits for a permission, or the task is blocked), then
 * waiting for approval (in review), both for tasks assigned to you or to nobody; then assigned to
 * you, then due by Sunday (late ones included), so the same task never asks for attention twice.
 * Mentions are comments, so they are a list of their own.
 */
export function inboxOf<T extends InboxTask, N extends InboxNote>(
  input: {
    you: string;
    tasks: readonly T[];
    notes?: readonly N[] | undefined;
    actors?: readonly InboxActor[] | undefined;
  },
  now: Date,
  selves?: ReadonlySet<string>,
): { needs: T[]; approval: T[]; assigned: T[]; due: T[]; mentions: N[]; end: string } {
  const { you } = input;
  const open = input.tasks.filter((t) => !CLOSED.has(t.status));
  const yours = (t: T) => (t.assigneeIds ?? []).length === 0 || t.assigneeIds?.includes(you);
  const asking = open
    .filter((t) => yours(t) && waitingOn(t, now.getTime()))
    .sort((a, b) => ((a.claim?.waiting?.since ?? "") < (b.claim?.waiting?.since ?? "") ? -1 : 1));
  const blocked = open.filter((t) => yours(t) && t.status === "blocked" && !asking.includes(t));
  const needs = [...asking, ...blocked];
  const shown = new Set(needs.map((t) => t.id));
  const approval = open.filter((t) => !shown.has(t.id) && t.status === "review" && yours(t));
  for (const t of approval) shown.add(t.id);
  const assigned = open.filter((t) => !shown.has(t.id) && t.assigneeIds?.includes(you)).sort(byDue);
  for (const t of assigned) shown.add(t.id);
  const end = weekEnd(now);
  const due = open
    .filter((t) => !shown.has(t.id) && t.dueDate != null && t.dueDate <= end)
    .sort(byDue);
  const me = (input.actors ?? []).find((a) => a.id === you);
  const mentions = me ? mentionsOf(input.notes ?? [], me, now, selves) : [];
  return { needs, approval, assigned, due, mentions, end };
}

/** How many things call for an answer: assigned and due tasks are plans, not calls. */
export function inboxCount(lists: {
  needs: readonly unknown[];
  approval: readonly unknown[];
  mentions: readonly unknown[];
}): number {
  return lists.needs.length + lists.approval.length + lists.mentions.length;
}
