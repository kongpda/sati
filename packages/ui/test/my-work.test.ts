import { describe, expect, it } from "vitest";
import { dueLabel, phoneColumn, type Snapshot, type Task } from "../src/api.js";
import { oneFile } from "../src/memory.js";
import { inboxCount, mentionsOf, myWork, weekEnd } from "../src/my-work.js";
import { mentionAt, mentionNames } from "../src/thread.js";

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

// The rule itself is tested in the core (`packages/core/test/inbox.test.ts`), where it lives.
// These cases pin what the board adds: the snapshot's shape and the name a person is called by.
describe("myWork", () => {
  it("builds the lists from a snapshot with the core's rule", () => {
    const tasks = [
      task({ title: "review, nobody's", status: "review" }),
      task({ title: "mine, Friday", assigneeIds: [you], dueDate: "2026-11-06" }),
      task({ title: "Sunday", dueDate: "2026-11-08" }),
      task({ title: "blocked", status: "blocked", blockedReason: "no key" }),
    ];
    const lists = myWork(snap(tasks), wed);
    const titles = (l: Task[]) => l.map((t) => t.title);
    expect(titles(lists.needs)).toEqual(["blocked"]);
    expect(titles(lists.approval)).toEqual(["review, nobody's"]);
    expect(titles(lists.assigned)).toEqual(["mine, Friday"]);
    expect(titles(lists.due)).toEqual(["Sunday"]);
    expect(lists.end).toBe(weekEnd(wed));
    expect(lists.end).toBe("2026-11-08");
  });
});

// PLAN Phase 7d: a person with no terminal learns that a teammate called them from the board
// alone. A mention must not need "mark as read" state, and must not nag once it is answered.
describe("mentions", () => {
  const actors = [
    { id: you, name: "ann@laptop", kind: "human", displayName: "Ann Lee" },
    { id: other, name: "bob@desk", kind: "human" },
  ];
  let c = 0;
  const comment = (body: string, at: string, by = other, on = "tsk_a") => ({
    id: `nte_${++c}`,
    title: "",
    body,
    tags: ["comment"],
    links: [on],
    pinned: false,
    createdAt: at,
    createdBy: by,
    updatedAt: at,
    version: 1,
  });
  const now = new Date("2026-11-11T12:00:00.000Z");
  const board = (notes: ReturnType<typeof comment>[], tasks: Task[] = []) =>
    ({ you, tasks, actors, notes, decisions: [] }) as unknown as Snapshot;

  it("lists comments that call you by name, until you answer on that record", () => {
    const notes = [
      comment("@ann can you check the budget?", "2026-11-10T09:00:00.000Z"),
      comment("cc @Ann Lee", "2026-11-10T10:00:00.000Z", other, "tsk_b"),
      comment("mail bob@ann.com, ask @annette", "2026-11-10T11:00:00.000Z"),
      comment("@ann old news", "2026-10-01T09:00:00.000Z"),
      comment("note to self @ann", "2026-11-10T12:00:00.000Z", you, "tsk_c"),
    ];
    expect(mentionsOf(board(notes), now).map((n) => n.body)).toEqual([
      "cc @Ann Lee",
      "@ann can you check the budget?",
    ]);
    // Ann replies on tsk_a: that mention is done, the other still waits.
    notes.push(comment("Checked, fine.", "2026-11-10T13:00:00.000Z", you));
    expect(mentionsOf(board(notes), now).map((n) => n.body)).toEqual(["cc @Ann Lee"]);
  });

  // The point of offering names: a picked name must reach its person. A handle My work does
  // not answer to would look sent and arrive nowhere.
  it("offers names after @ that land in that person's My work when picked", () => {
    const team = [
      { id: you, name: "ann@laptop", kind: "human", displayName: "Ann Lee" },
      { id: other, name: "bob@desk", kind: "human" },
      { id: "actr_c", name: "chan@desk", kind: "human", displayName: "Sok Chan" },
      { id: "actr_a1", name: "claude-code@main#1111", kind: "agent" },
      { id: "actr_a2", name: "claude-code@main#2222", kind: "agent" },
    ];
    const as = (who: string) =>
      ({ you: who, tasks: [], actors: team, notes: [] }) as unknown as Snapshot;
    // People first, yourself left out, an agent's sessions offered once.
    expect(mentionNames(as(you), "").map((m) => m.handle)).toEqual(["bob", "Sok", "claude-code"]);
    // Either word of the shown name finds the person.
    expect(mentionNames(as(you), "cha").map((m) => m.handle)).toEqual(["Sok"]);
    expect(mentionNames(as(you), "zz")).toEqual([]);
    for (const who of [you, other, "actr_c"]) {
      const from = who === you ? other : you;
      const mine = mentionNames(as(from), "").find(
        (m) => m.name === (who === you ? "Ann Lee" : who === other ? "bob" : "Sok Chan"),
      );
      const said = [comment(`@${mine?.handle} please look`, "2026-11-11T09:00:00.000Z", from)];
      const seen = { ...as(who), notes: said } as unknown as Snapshot;
      expect(mentionsOf(seen, now).map((n) => n.body)).toEqual(said.map((n) => n.body));
    }
  });

  it("finds the @word at the caret, not an email address or a finished word", () => {
    expect(mentionAt("ask @bo", 7)).toEqual({ start: 4, query: "bo" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("mail bob@ann", 12)).toBeNull();
    expect(mentionAt("ask @bob now", 12)).toBeNull();
    // The caret is in the middle of the text: only what is before it counts.
    expect(mentionAt("ask @bo later", 7)).toEqual({ start: 4, query: "bo" });
  });

  it("counts mentions, questions and approvals next to My work, not plain assigned tasks", () => {
    const tasks = [task({ status: "review" }), task({ assigneeIds: [you], dueDate: "2026-11-12" })];
    const notes = [comment("@ann please look", "2026-11-11T09:00:00.000Z")];
    expect(inboxCount(board(notes, tasks), now)).toBe(2);
  });
});

// Approve is offered only where there is one version to sign off: the server refuses the rest.
describe("oneFile", () => {
  it("is true for one project file, not a folder, wildcard, part or link", () => {
    expect(oneFile("venue/hall-b-quote.pdf")).toBe(true);
    for (const path of [
      "venue/",
      "src/**/*.ts",
      "plan.md#budget",
      "https://x.test/a.pdf",
      "/etc/hosts",
      "C:\\x.pdf",
    ]) {
      expect(oneFile(path)).toBe(false);
    }
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
