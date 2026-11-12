import { describe, expect, it } from "vitest";
import {
  addComment,
  claimTask,
  completeTask,
  createTask,
  ensureActor,
  InboxOutput,
  inbox,
  inboxCount,
  inboxOf,
  markWaiting,
  mentionsOf,
  type ServiceContext,
  updateTask,
  weekEnd,
} from "../src/index.js";
import { setup } from "./support/setup.js";

/*
 * The pure cases came from the board's `my-work.test.ts` with their inputs and expectations
 * unchanged, when the rule moved here so that `sati inbox` and the MCP `inbox` tool could share
 * it. A change that breaks one of them changes what a person sees on My work.
 */
const you = "actr_you";
const other = "actr_other";
interface T {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate?: string;
  assigneeIds?: string[];
  blockedReason?: string;
  claim?: {
    actorId: string;
    leaseUntil: string;
    waiting?: { kind: "question"; text: string; since: string };
  } | null;
}
let n = 0;
function task(fields: Partial<T>): T {
  n++;
  return { id: `tsk_${n}`, title: `t${n}`, status: "todo", priority: "medium", ...fields };
}
// Wednesday 4 Nov 2026, local time.
const wed = new Date(2026, 10, 4, 15, 0);

describe("weekEnd", () => {
  it("is the coming Sunday, and Sunday itself on a Sunday", () => {
    expect(weekEnd(wed)).toBe("2026-11-08");
    expect(weekEnd(new Date(2026, 10, 7, 23, 59))).toBe("2026-11-08");
    expect(weekEnd(new Date(2026, 10, 8, 0, 1))).toBe("2026-11-08");
    expect(weekEnd(new Date(2026, 10, 9))).toBe("2026-11-15");
  });
});

describe("inboxOf", () => {
  it("puts each open task in the first list it fits, soonest due first", () => {
    const tasks = [
      task({ title: "review, mine", status: "review", assigneeIds: [you] }),
      task({ title: "review, nobody's", status: "review" }),
      task({ title: "review, theirs", status: "review", assigneeIds: [other] }),
      task({ title: "mine, undated", assigneeIds: [you], priority: "high" }),
      task({ title: "mine, Friday", assigneeIds: [you], dueDate: "2026-11-06" }),
      task({ title: "late, theirs", assigneeIds: [other], dueDate: "2026-10-30" }),
      task({ title: "Sunday", dueDate: "2026-11-08" }),
      task({ title: "next Monday", dueDate: "2026-11-09" }),
      task({ title: "done, due", status: "done", dueDate: "2026-11-05", assigneeIds: [you] }),
      task({ title: "cancelled", status: "cancelled", assigneeIds: [you] }),
    ];
    const lists = inboxOf({ you, tasks }, wed);
    const titles = (l: T[]) => l.map((t) => t.title);
    expect(titles(lists.approval)).toEqual(["review, mine", "review, nobody's"]);
    expect(titles(lists.assigned)).toEqual(["mine, Friday", "mine, undated"]);
    expect(titles(lists.due)).toEqual(["late, theirs", "Sunday"]);
    expect(lists.end).toBe("2026-11-08");
  });

  // PLAN Phase 5c: an agent's question comes before approvals, and a task asks only once.
  it("puts questions, then blocked tasks, under Needs you, ahead of approval", () => {
    const live = "2026-11-04T16:00:00.000Z";
    const ask = (text: string, since: string) => ({
      actorId: other,
      leaseUntil: live,
      waiting: { kind: "question" as const, text, since },
    });
    const tasks = [
      task({ title: "blocked", status: "blocked", blockedReason: "no key" }),
      task({
        title: "asks later",
        status: "in_progress",
        claim: ask("b?", "2026-11-04T14:30:00.000Z"),
      }),
      task({ title: "asks first", status: "review", claim: ask("a?", "2026-11-04T14:00:00.000Z") }),
      task({
        title: "theirs asks",
        status: "in_progress",
        assigneeIds: [other],
        claim: ask("c?", "2026-11-04T14:00:00.000Z"),
      }),
      task({
        title: "lease over",
        status: "in_progress",
        claim: { ...ask("d?", "2026-11-04T13:00:00.000Z"), leaseUntil: "2026-11-04T14:59:00.000Z" },
      }),
    ];
    const lists = inboxOf({ you, tasks }, new Date("2026-11-04T15:00:00.000Z"));
    expect(lists.needs.map((t) => t.title)).toEqual(["asks first", "asks later", "blocked"]);
    // In review and asking: it shows under Needs you only.
    expect(lists.approval).toEqual([]);
  });
});

// PLAN Phase 7d: a person with no terminal learns that a teammate called them from the board
// alone. A mention must not need "mark as read" state, and must not nag once it is answered.
describe("mentions", () => {
  const ann = { id: you, name: "ann@laptop", displayName: "Ann Lee" };
  let c = 0;
  const comment = (body: string, at: string, by = other, on = "tsk_a") => ({
    id: `nte_${++c}`,
    body,
    tags: ["comment"],
    links: [on],
    createdAt: at,
    createdBy: by,
  });
  const now = new Date("2026-11-11T12:00:00.000Z");

  it("lists comments that call you by name, until you answer on that record", () => {
    const notes = [
      comment("@ann can you check the budget?", "2026-11-10T09:00:00.000Z"),
      comment("cc @Ann Lee", "2026-11-10T10:00:00.000Z", other, "tsk_b"),
      comment("mail bob@ann.com, ask @annette", "2026-11-10T11:00:00.000Z"),
      comment("@ann old news", "2026-10-01T09:00:00.000Z"),
      comment("note to self @ann", "2026-11-10T12:00:00.000Z", you, "tsk_c"),
    ];
    expect(mentionsOf(notes, ann, now).map((m) => m.body)).toEqual([
      "cc @Ann Lee",
      "@ann can you check the budget?",
    ]);
    // Ann replies on tsk_a: that mention is done, the other still waits.
    notes.push(comment("Checked, fine.", "2026-11-10T13:00:00.000Z", you));
    expect(mentionsOf(notes, ann, now).map((m) => m.body)).toEqual(["cc @Ann Lee"]);
  });

  it("counts mentions, questions and approvals, not plain assigned tasks", () => {
    const tasks = [task({ status: "review" }), task({ assigneeIds: [you], dueDate: "2026-11-12" })];
    const notes = [comment("@ann please look", "2026-11-11T09:00:00.000Z")];
    expect(inboxCount(inboxOf({ you, tasks, notes, actors: [ann] }, now))).toBe(2);
  });

  // A deleted comment is gone from the thread, so it must stop calling its reader too.
  it("leaves out a deleted comment", () => {
    const gone = { ...comment("@ann look", "2026-11-11T09:00:00.000Z"), deletedAt: "2026-11-11" };
    expect(mentionsOf([gone], ann, now)).toEqual([]);
  });
});

// The terminal and the MCP tool read the stored records: what a person sees there must be the
// same tasks, in the same sections, as the board builds from its snapshot.
describe("inbox service", () => {
  async function as(ctx: ServiceContext, name: string, kind: "agent" | "human") {
    const actor = await ensureActor(ctx, { name, kind, tool: null, worktree: null });
    return { ...ctx, actorId: actor.id };
  }

  it("returns each section for the person asked about, with the fields a row shows", async () => {
    const { ctx } = await setup();
    const kim = await as(ctx, "kim@main", "human");
    const asked = await createTask(ctx, { title: "Pick a database" });
    await claimTask(ctx, asked.id);
    await markWaiting(ctx, { taskId: asked.id, waiting: { text: "Postgres or SQLite?" } });
    const built = await createTask(ctx, { title: "Build the export" });
    const claim = await claimTask(ctx, built.id);
    await completeTask(ctx, built.id, {
      summary: "Export writes CSV.",
      filesTouched: ["src/export.ts"],
      token: claim.claim?.token,
    });
    const mine = await createTask(ctx, { title: "Write the notes", assigneeIds: [kim.actorId] });
    const soon = await createTask(ctx, { title: "Send the invoice", dueDate: "2026-11-05" });
    await createTask(ctx, { title: "Far away", dueDate: "2027-01-01" });
    const stuck = await createTask(ctx, { title: "Deploy" });
    await updateTask(kim, stuck.id, { status: "blocked", reason: "No server key." });
    await addComment(ctx, { on: soon.id, body: "@kim is this the right amount?" });

    const out = await inbox(kim);
    expect(InboxOutput.parse(out)).toEqual(out);
    expect(out.for.name).toBe("kim@main");
    expect(out.needsAnswer.map((t) => t.id)).toEqual([asked.id, stuck.id]);
    expect(out.needsAnswer[0]?.asks).toMatchObject({
      kind: "question",
      text: "Postgres or SQLite?",
      by: "claude-code@main#1",
    });
    expect(out.needsAnswer[1]?.blockedReason).toBe("No server key.");
    expect(out.approval).toMatchObject([
      { id: built.id, summary: "Export writes CSV.", completedBy: "claude-code@main#1", files: 1 },
    ]);
    expect(out.assigned.map((t) => t.id)).toEqual([mine.id]);
    expect(out.due.map((t) => t.id)).toEqual([soon.id]);
    expect(out.mentions).toMatchObject([
      { on: soon.id, onTitle: "Send the invoice", by: "claude-code@main#1" },
    ]);
    expect(out.count).toBe(4);

    // An agent asks for the person by name, as the MCP tool does: the same answer.
    expect(await inbox(ctx, { for: "kim" })).toEqual(out);
    expect(await inbox(ctx, { for: kim.actorId })).toEqual(out);
    // The agent's own inbox is another list: nothing is assigned to it, nobody called it.
    const own = await inbox(ctx);
    expect(own.assigned).toEqual([]);
    expect(own.mentions).toEqual([]);
  });

  it("refuses a name that is nobody, with what to pass", async () => {
    const { ctx } = await setup();
    await expect(inbox(ctx, { for: "nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: 'No actor is named "nobody".',
    });
  });
});
