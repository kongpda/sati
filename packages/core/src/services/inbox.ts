import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { parseHandle, parseId } from "../domain/ids.js";
import { CLOSED, inboxCount, inboxOf, mentionsSince, waitingOn } from "../domain/inbox.js";
import type { Actor, Note, Task } from "../domain/schemas.js";
import { TASK_STATUSES } from "../domain/status.js";
import { isDeleted, listAll, parseInput, type ServiceContext, UNKNOWN_ACTOR } from "./context.js";
import { resolveId } from "./query.js";

export { inboxCount, inboxOf, waitingOn, weekEnd } from "../domain/inbox.js";

export const InboxInput = z.strictObject({
  /** Whose inbox: an actor id, handle or name. Default: the caller. */
  for: z.string().trim().min(1).max(200).optional(),
});
export type InboxInput = z.input<typeof InboxInput>;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const InboxTaskRow = z.strictObject({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  dueDate: day.optional(),
  /** What its holder waits on a person for, in the holder's words. */
  asks: z
    .strictObject({
      kind: z.enum(["question", "permission"]),
      text: z.string(),
      since: z.string(),
      by: z.string(),
    })
    .optional(),
  blockedReason: z.string().optional(),
  /** What was done, for a task waiting for approval. */
  summary: z.string().optional(),
  completedBy: z.string().optional(),
  files: z.number().int().optional(),
});
const InboxMentionRow = z.strictObject({
  /** The comment. */
  id: z.string(),
  /** The record it is on, and that record's title. */
  on: z.string(),
  onTitle: z.string(),
  by: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

/** What `inbox` returns: the same lists, in the same order, as the board's My work page. */
export const InboxOutput = z.strictObject({
  for: z.strictObject({ id: z.string(), name: z.string() }),
  /** The last day of this week, which `due` runs to. */
  end: day,
  /** Questions and blocked tasks, approvals and mentions: the things that call for an answer. */
  count: z.number().int(),
  needsAnswer: z.array(InboxTaskRow),
  mentions: z.array(InboxMentionRow),
  approval: z.array(InboxTaskRow),
  assigned: z.array(InboxTaskRow),
  due: z.array(InboxTaskRow),
});
export type InboxOutput = z.infer<typeof InboxOutput>;
export type InboxTaskRow = z.infer<typeof InboxTaskRow>;
export type InboxMentionRow = z.infer<typeof InboxMentionRow>;

const OPEN = TASK_STATUSES.filter((s) => !CLOSED.has(s));

/** What a comment can be on, by id prefix. */
const COMMENTED: Record<string, "task" | "note" | "decision"> = {
  tsk: "task",
  note: "note",
  dec: "decision",
};

/** The actor named by a resolved id, or by name. A name is tried last: it may look like anything. */
function whose(actors: readonly Actor[], ref: string, id: string | null): Actor {
  const lower = ref.toLowerCase();
  const found = id
    ? actors.filter((a) => a.id === id)
    : actors.filter(
        (a) =>
          a.name.toLowerCase() === lower ||
          a.displayName?.toLowerCase() === lower ||
          (a.kind === "human" && a.name.split("@")[0]?.toLowerCase() === lower),
      );
  if (found.length === 1 && found[0]) return found[0];
  throw new SatiError(
    found.length ? "AMBIGUOUS" : "NOT_FOUND",
    found.length ? `"${ref}" names ${found.length} actors.` : `No actor is named "${ref}".`,
    { hint: "Pass an actor id (actr_8f3k2a) or the full name, such as ann@laptop." },
  );
}

/**
 * What waits for one actor: questions agents ask and blocked tasks, comments that call them,
 * tasks to approve, tasks assigned to them and tasks due this week. One read; nothing is stored.
 *
 * It reads open tasks and the notes changed in the time a mention lasts, not every record: the
 * lists come out the same (`inboxOf` drops the rest), and the cost follows the open work, not
 * the age of the project.
 */
export async function inbox(ctx: ServiceContext, input: unknown = {}): Promise<InboxOutput> {
  const { for: ref } = parseInput(InboxInput, input);
  const now = ctx.clock.now();
  const byId = ref && (parseId(ref)?.prefix === "actr" || parseHandle(ref)?.prefix === "actr");
  // Resolved before the read below: a store does not nest reads.
  const id = ref && byId ? await resolveId(ctx, "actor", ref) : null;
  return ctx.store.read(async (r) => {
    const actors = await listAll(r, ctx, "actor");
    const me = ref ? whose(actors, ref, id) : actors.find((a) => a.id === ctx.actorId);
    if (!me) throw new SatiError("NOT_FOUND", "This actor is not known in this project.");
    const tasks = await listAll(r, ctx, "task", { status: OPEN });
    const notes = await listAll(r, ctx, "note", { updatedSince: mentionsSince(now) });
    // An agent's sessions are one agent: an answer by an earlier session ends the mention.
    const handle = me.name.split("@")[0];
    const selves = new Set(
      me.kind === "agent"
        ? actors
            .filter((a) => a.kind === "agent" && a.name.split("@")[0] === handle)
            .map((a) => a.id)
        : [],
    );
    const lists = inboxOf({ you: me.id, tasks, notes, actors }, now, selves);
    const names = new Map(actors.map((a) => [a.id, a.displayName ?? a.name]));
    const name = (id: string) => names.get(id) ?? UNKNOWN_ACTOR;
    // A mention may be on a closed task or an old note, which the lists above do not hold.
    const titles = new Map<string, string>();
    for (const on of new Set(lists.mentions.map((n) => n.links[0] ?? ""))) {
      const entity = COMMENTED[parseId(on)?.prefix ?? ""];
      const record = entity ? await r.get(entity, on) : undefined;
      if (record && record.projectId === ctx.projectId && !isDeleted(record)) {
        titles.set(on, record.title);
      }
    }
    const row = (t: Task): InboxTaskRow => {
      const asks = waitingOn(t, now.getTime());
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        ...(t.dueDate ? { dueDate: t.dueDate } : {}),
        ...(asks && t.claim ? { asks: { ...asks, by: name(t.claim.actorId) } } : {}),
        ...(t.status === "blocked" && t.blockedReason ? { blockedReason: t.blockedReason } : {}),
        ...(t.status === "review" && t.completion
          ? {
              summary: t.completion.summary,
              completedBy: name(t.completion.completedBy),
              files: t.completion.filesTouched.length,
            }
          : {}),
      };
    };
    const mention = (n: Note): InboxMentionRow => ({
      id: n.id,
      on: n.links[0] ?? "",
      onTitle: titles.get(n.links[0] ?? "") ?? "",
      by: name(n.createdBy),
      body: n.body,
      createdAt: n.createdAt,
    });
    return {
      for: { id: me.id, name: me.displayName ?? me.name },
      end: lists.end,
      count: inboxCount(lists),
      needsAnswer: lists.needs.map(row),
      mentions: lists.mentions.map(mention),
      approval: lists.approval.map(row),
      assigned: lists.assigned.map(row),
      due: lists.due.map(row),
    };
  });
}
