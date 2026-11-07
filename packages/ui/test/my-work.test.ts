import { describe, expect, it } from "vitest";
import { dueLabel, phoneColumn, type Snapshot, type Task } from "../src/api.js";
import { myWork, weekEnd } from "../src/my-work.js";

const you = "actr_you";
const other = "actr_other";
let n = 0;
function task(fields: Partial<Task>): Task {
  n++;
  return {
    id: `tsk_${n}`,
    title: `t${n}`,
    body: "",
    status: "todo",
    priority: "medium",
    featureId: null,
    version: 1,
    updatedAt: "2026-11-01T00:00:00.000Z",
    claim: null,
    completion: null,
    ...fields,
  };
}
const snap = (tasks: Task[]) => ({ you, tasks }) as unknown as Snapshot;
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

describe("myWork", () => {
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
    const lists = myWork(snap(tasks), wed);
    const titles = (l: Task[]) => l.map((t) => t.title);
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
    const lists = myWork(snap(tasks), new Date("2026-11-04T15:00:00.000Z"));
    expect(lists.needs.map((t) => t.title)).toEqual(["asks first", "asks later", "blocked"]);
    // In review and asking: it shows under Needs you only.
    expect(lists.approval).toEqual([]);
  });
});

describe("board words", () => {
  // Trial: a plan made in November had every due date in next year, shown without the year.
  it("shows the year on a due date in another year", () => {
    const now = new Date(2026, 10, 8);
    expect(dueLabel("2026-11-20", "todo", now).text).not.toMatch(/2026/u);
    expect(dueLabel("2027-01-23", "todo", now).text).toMatch(/2027/u);
  });

  // Trial: a new plan opened on an empty Working on it column on a phone.
  it("opens a phone on the first column with tasks", () => {
    expect(phoneColumn([{ status: "todo" }, { status: "backlog" }])).toBe("todo");
    expect(phoneColumn([{ status: "todo" }, { status: "review" }])).toBe("review");
    expect(phoneColumn([{ status: "done" }])).toBe("in_progress");
  });
});
