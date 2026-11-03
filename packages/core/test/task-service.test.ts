import { describe, expect, it } from "vitest";
import {
  completeTask,
  createFeature,
  createTask,
  getRecord,
  listTasks,
  updateTask,
} from "../src/index.js";
import { setup } from "./support/setup.js";

const done = { summary: "did it", filesTouched: ["src/a.ts"] };

describe("createTask", () => {
  it("fills defaults, records the actor and logs one create row", async () => {
    const { ctx, store, actor } = await setup();
    const before = store.activity.length;
    const t = await createTask(ctx, { title: "Write tests" });
    expect(t).toMatchObject({
      status: "todo",
      priority: "medium",
      createdBy: actor.id,
      version: 1,
    });
    expect(store.activity.slice(before)).toEqual([
      expect.objectContaining({
        verb: "create",
        entityId: t.id,
        actorId: actor.id,
        branch: "main",
      }),
    ]);
  });

  // Agents must not skip the workflow by creating tasks already in progress or done.
  it("only starts tasks in backlog or todo", async () => {
    const { ctx } = await setup();
    await expect(createTask(ctx, { title: "x", status: "in_progress" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("rejects unknown fields and oversize input", async () => {
    const { ctx } = await setup();
    await expect(createTask(ctx, { title: "x", owner: "me" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(createTask(ctx, { title: "x".repeat(301) })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("requires linked feature and dependencies to exist", async () => {
    const { ctx } = await setup();
    const missing = "tsk_01JC0000000000000000000099";
    await expect(createTask(ctx, { title: "x", dependsOn: [missing] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const f = await createFeature(ctx, { title: "Board" });
    expect((await createTask(ctx, { title: "x", featureId: f.id })).featureId).toBe(f.id);
  });
});

describe("updateTask", () => {
  // A cycle would make every task in it permanently unready.
  it("rejects a dependency cycle and writes nothing", async () => {
    const { ctx, store } = await setup();
    const a = await createTask(ctx, { title: "a" });
    const b = await createTask(ctx, { title: "b", dependsOn: [a.id] });
    const c = await createTask(ctx, { title: "c", dependsOn: [b.id] });
    const rows = store.activity.length;
    const err = await updateTask(ctx, a.id, { dependsOn: [c.id] }).catch((e) => e);
    expect(err.code).toBe("VALIDATION");
    expect(err.details.cycle).toEqual([a.id, c.id, b.id, a.id]);
    expect((await getRecord(ctx, "task", a.id)).dependsOn).toEqual([]);
    expect(store.activity.length).toBe(rows);
  });

  it("rejects a self-dependency and a parent loop", async () => {
    const { ctx } = await setup();
    const a = await createTask(ctx, { title: "a" });
    const b = await createTask(ctx, { title: "b", parentId: a.id });
    await expect(updateTask(ctx, a.id, { dependsOn: [a.id] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(updateTask(ctx, a.id, { parentId: b.id })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("enforces the status machine and points to complete for done", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x", status: "backlog" });
    await expect(updateTask(ctx, t.id, { status: "review" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      hint: expect.stringContaining("todo"),
    });
    await expect(updateTask(ctx, t.id, { status: "done" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      hint: expect.stringContaining("complete"),
    });
  });

  it("logs status changes with the status verb and a field diff", async () => {
    const { ctx, store } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const u = await updateTask(ctx, t.id, { status: "in_progress" });
    expect(u.version).toBe(2);
    expect(store.activity.at(-1)).toMatchObject({
      verb: "status",
      diff: { status: { from: "todo", to: "in_progress" } },
    });
  });

  it("writes nothing for a no-op update", async () => {
    const { ctx, store } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const rows = store.activity.length;
    expect(await updateTask(ctx, t.id, { title: "x" })).toEqual(t);
    expect(store.activity.length).toBe(rows);
  });

  // Two agents editing the same task: the one holding a stale copy must not win silently.
  it("rejects a stale expectedVersion", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await updateTask(ctx, t.id, { title: "y" });
    await expect(updateTask(ctx, t.id, { title: "z", expectedVersion: 1 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("completeTask", () => {
  it("needs a summary and at least one file", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await updateTask(ctx, t.id, { status: "in_progress" });
    await expect(
      completeTask(ctx, t.id, { summary: "ok", filesTouched: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("records who finished it, releases the claim and unblocks dependents", async () => {
    const { ctx, actor, store } = await setup();
    const dep = await createTask(ctx, { title: "dep" });
    const next = await createTask(ctx, { title: "next", dependsOn: [dep.id] });
    expect((await listTasks(ctx, { ready: true })).map((t) => t.id)).toEqual([dep.id]);

    await updateTask(ctx, dep.id, { status: "in_progress" });
    const finished = await completeTask(ctx, dep.id, done);
    expect(finished).toMatchObject({
      status: "done",
      claim: null,
      completion: { ...done, completedBy: actor.id },
    });
    expect(store.activity.at(-1)?.verb).toBe("complete");
    expect((await listTasks(ctx, { ready: true })).map((t) => t.id)).toEqual([next.id]);
  });

  it("refuses to complete a task that was never started", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await expect(completeTask(ctx, t.id, done)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("clears the completion when a done task is reopened", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await updateTask(ctx, t.id, { status: "in_progress" });
    await completeTask(ctx, t.id, done);
    const reopened = await updateTask(ctx, t.id, { status: "todo" });
    expect(reopened.completion).toBeNull();
  });
});

describe("listTasks", () => {
  it("filters by status and label", async () => {
    const { ctx } = await setup();
    await createTask(ctx, { title: "a", labels: ["ui"] });
    await createTask(ctx, { title: "b", status: "backlog" });
    expect(await listTasks(ctx, { label: "ui" })).toHaveLength(1);
    expect(await listTasks(ctx, { status: ["backlog"] })).toHaveLength(1);
    await expect(listTasks(ctx, { status: ["nope"] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
