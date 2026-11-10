import micromatch from "micromatch";
import { describe, expect, it, vi } from "vitest";
import {
  buildBrief,
  changes,
  createFeature,
  createMilestone,
  createNote,
  createTask,
  deleteRecord,
  doctorChecks,
  importPlan,
  isCompacted,
  listRecords,
  listTasks,
  PRIORITY_RANK,
  shortHandle,
  undoActivity,
  updateNote,
  updateWithLog,
  writeHandoff,
} from "../src/index.js";
import { setup } from "./support/setup.js";

describe("undoActivity with long text", () => {
  // The log keeps only "<N chars>" for long text. Undoing must refuse instead of writing
  // that placeholder over the user's real note body.
  it("refuses to revert a field the log could not keep", async () => {
    const { ctx, store } = await setup();
    const note = await createNote(ctx, { title: "N", body: "a".repeat(500) });
    await updateNote(ctx, note.id, { body: "b".repeat(600) });
    const write = store.activity.find((r) => r.verb === "update" && r.entityId === note.id);
    expect(isCompacted((write?.diff.body as { from: unknown } | undefined)?.from)).toBe(true);
    await expect(undoActivity(ctx, write?.id ?? "")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const kept = await ctx.store.read((r) => r.get("note", note.id));
    expect(kept?.body).toBe("b".repeat(600));
  });
});

describe("changes / updateWithLog", () => {
  // A patch that only adds an optional key must be seen as a change, or it is silently dropped.
  it("diffs keys that exist only in the new value", () => {
    expect(changes({ a: 1 }, { a: 1, needsReview: true })).toEqual({
      needsReview: { from: undefined, to: true },
    });
  });

  it("writes a patch that only adds an absent optional key", async () => {
    const { ctx } = await setup();
    const note = await createNote(ctx, { title: "N" });
    const after = await ctx.store.write((w) =>
      updateWithLog(w, ctx, "note", note, { needsReview: true }),
    );
    expect(after.version).toBe(note.version + 1);
    expect(after.needsReview).toBe(true);
  });
});

describe("listTasks ready filters", () => {
  // `--ready --feature X` must not return ready tasks of other features.
  it("applies feature, label, status, offset and limit to ready tasks", async () => {
    const { ctx } = await setup();
    const f = await createFeature(ctx, { title: "F" });
    const a = await createTask(ctx, { title: "a", featureId: f.id, labels: ["x"] });
    await createTask(ctx, { title: "b", featureId: f.id });
    await createTask(ctx, { title: "c" });
    const byFeature = await listTasks(ctx, { ready: true, featureId: f.id });
    expect(byFeature.map((t) => t.title).sort()).toEqual(["a", "b"]);
    expect((await listTasks(ctx, { ready: true, label: "x" })).map((t) => t.id)).toEqual([a.id]);
    expect(await listTasks(ctx, { ready: true, status: ["done"] })).toEqual([]);
    expect(await listTasks(ctx, { ready: true, limit: 1, offset: 2 })).toHaveLength(1);
    expect(await listTasks(ctx, { ready: true, offset: 3 })).toHaveLength(0);
  });
});

describe("createTask subtasks", () => {
  // A subtask that waits on itself or on a loop never becomes ready.
  it("rejects a self-dependency and a cycle among subtasks", async () => {
    const { ctx } = await setup();
    const self = createTask(ctx, { title: "p", subtasks: [{ title: "s", dependsOn: [0] }] });
    await expect(self).rejects.toMatchObject({ code: "VALIDATION" });
    const loop = createTask(ctx, {
      title: "p",
      subtasks: [
        { title: "a", dependsOn: [1] },
        { title: "b", dependsOn: [0] },
      ],
    });
    await expect(loop).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await listTasks(ctx, {})).toHaveLength(0);
  });

  it("still accepts a chain", async () => {
    const { ctx } = await setup();
    await createTask(ctx, {
      title: "p",
      subtasks: [{ title: "a" }, { title: "b", dependsOn: [0] }],
    });
    expect(await listTasks(ctx, {})).toHaveLength(3);
  });
});

describe("buildBrief globs", () => {
  // Each glob must be compiled once, not once per file, or big repos make the brief slow.
  it("compiles each feature glob once", async () => {
    const { ctx } = await setup();
    const f = await createFeature(ctx, {
      title: "F",
      status: "building",
      paths: ["src/**", "lib/**"],
    });
    const files = Array.from({ length: 40 }, (_, i) => ({ path: `docs/f${i}.md`, blob: "b" }));
    ctx.repo = { files: async () => files, head: async () => null };
    const spy = vi.spyOn(micromatch, "matcher");
    const slow = vi.spyOn(micromatch, "isMatch");
    const md = (await buildBrief(ctx)).markdown;
    // Both globs match none of the files, so the feature is reported as stale.
    expect(md).toContain(`${shortHandle(f.id)} F: src/**, lib/**`);
    expect(slow).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    slow.mockRestore();
  });
});

describe("importPlan", () => {
  // A deleted task must not come back on re-import, and a failure must not leave half a plan.
  it("does not re-create deleted tasks", async () => {
    const { ctx } = await setup();
    const md = "# M\n- [ ] one\n";
    await importPlan(ctx, { markdown: md });
    const [task] = await listTasks(ctx, {});
    await deleteRecord(ctx, "task", task?.id ?? "");
    const again = await importPlan(ctx, { markdown: md });
    expect(again.added).toEqual([]);
    expect(await listTasks(ctx, {})).toHaveLength(0);
  });

  // Each heading is a milestone; its tasks must belong to it, so "what is left for M?" works.
  it("puts each task in its heading's milestone, also when re-run with new items", async () => {
    const { ctx } = await setup();
    await importPlan(ctx, { markdown: "# Venue\n- [ ] Book hall\n# Food\n- [ ] Pick menu\n" });
    await importPlan(ctx, { markdown: "# Venue\n- [ ] Book hall\n- [ ] Pay deposit\n" });
    const milestones = await listRecords(ctx, "milestone", {});
    const venue = milestones.find((m) => m.title === "Venue")?.id;
    const tasks = await listTasks(ctx, { milestoneId: venue });
    expect(tasks.map((t) => t.title).sort()).toEqual(["Book hall", "Pay deposit"]);
  });

  // Review WP2.4: a plan that shows a checklist example in a code block got tasks and a
  // milestone from the example.
  it("skips headings and boxes inside code fences", async () => {
    const { ctx } = await setup();
    const md = [
      "# Launch",
      "- [ ] Write the post",
      "```markdown",
      "# Example heading",
      "- [ ] Example item",
      "```",
      "~~~~",
      "- [ ] Tilde example",
      "~~~",
      "- [ ] Still in the tilde fence",
      "~~~~",
      "- [ ] Send it",
    ].join("\n");
    await importPlan(ctx, { markdown: md });
    expect((await listTasks(ctx, {})).map((t) => t.title).sort()).toEqual([
      "Send it",
      "Write the post",
    ]);
    const milestones = await listRecords(ctx, "milestone", {});
    expect(milestones.map((m) => m.title)).toEqual(["Launch"]);
  });

  it("rolls back everything when a write fails part-way", async () => {
    const { ctx, store } = await setup();
    const real = ctx.ids;
    let n = 0;
    ctx.ids = (e) => {
      if (e === "task" && ++n === 2) throw new Error("boom");
      return real(e);
    };
    await expect(importPlan(ctx, { markdown: "# M\n- [ ] one\n- [ ] two\n" })).rejects.toThrow(
      "boom",
    );
    ctx.ids = real;
    expect(await listTasks(ctx, {})).toHaveLength(0);
    expect(await store.read((r) => r.list("milestone", ctx.projectId, {}))).toHaveLength(0);
  });
});

describe("guarded features", () => {
  // The guard only enforces shipped features, so the brief must not list others as protected.
  it("lists only shipped protected features in the brief", async () => {
    const { ctx } = await setup();
    await createFeature(ctx, { title: "Plan", status: "planned", protected: true });
    await createFeature(ctx, { title: "Live", status: "shipped", protected: true });
    const md = (await buildBrief(ctx)).markdown;
    expect(md).toContain("Live (shipped)");
    expect(md).not.toContain("Plan (planned)");
  });
});

describe("createMilestone order", () => {
  // Counting rows hands out a duplicate once orders have gaps (e.g. an explicit order of 5).
  it("uses max+1, not the row count", async () => {
    const { ctx } = await setup();
    const a = await createMilestone(ctx, { title: "a", order: 5 });
    const b = await createMilestone(ctx, { title: "b" });
    expect([a.order, b.order]).toEqual([5, 6]);
  });
});

describe("doctorChecks needsReview", () => {
  // A flagged task beyond the first 500 rows must still be found.
  it("finds a flagged task among more than 500", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 510; i++) await createTask(ctx, { title: `t${i}` });
    const last = await createTask(ctx, { title: "flagged" });
    await ctx.store.write((w) => updateWithLog(w, ctx, "task", last, { needsReview: true }));
    const check = (await doctorChecks(ctx)).find((c) => c.name === "needsReview");
    expect(check?.ok).toBe(false);
  }, 60_000);
});

describe("writeHandoff", () => {
  // Two concurrent handoffs for one task must end up as one note.
  it("keeps one note under concurrent calls", async () => {
    const { ctx, store } = await setup();
    const task = await createTask(ctx, { title: "T" });
    await Promise.all([
      writeHandoff(ctx, { taskId: task.id, next: "a" }),
      writeHandoff(ctx, { taskId: task.id, next: "b" }),
    ]);
    const notes = await store.read((r) => r.list("note", ctx.projectId, {}));
    expect(notes).toHaveLength(1);
  });
});

describe("PRIORITY_RANK", () => {
  it("ranks urgent before low", () => {
    expect(PRIORITY_RANK.urgent).toBeLessThan(PRIORITY_RANK.low);
  });
});
