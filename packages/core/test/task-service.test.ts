import { describe, expect, it } from "vitest";
import {
  claimTask,
  completeTask,
  createFeature,
  createTask,
  ensureActor,
  getRecord,
  listTasks,
  releaseExpiredClaims,
  type ServiceContext,
  updateTask,
} from "../src/index.js";
import { START, setup } from "./support/setup.js";

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

describe("service input", () => {
  // Callers such as the CLI pass every flag, set or not. An unset flag must not wipe a default.
  it("treats undefined fields as absent", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x", body: undefined, priority: undefined });
    expect(t).toMatchObject({ body: "", priority: "medium", status: "todo" });
  });
});

describe("claimTask", () => {
  // Two agents must never both work on one task; the loser learns who holds it.
  it("claims a todo task and refuses a second actor while the lease is live", async () => {
    const { ctx, store, clock, actor } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const claimed = await claimTask(ctx, t.id);
    expect(claimed.status).toBe("in_progress");
    expect(claimed.claim).toEqual({
      actorId: actor.id,
      leaseUntil: "2026-11-03T12:30:00.000Z",
      heartbeatAt: START,
    });
    expect(store.activity.at(-1)).toMatchObject({ verb: "claim", entityId: t.id });

    const other = await otherActor(ctx);
    await expect(claimTask(other, t.id)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("claude-code@main#1"),
    });

    // Once the lease lapses, another agent may take over the abandoned task.
    clock.advance(31 * 60_000);
    expect((await claimTask(other, t.id)).claim?.actorId).toBe(other.actorId);
  });

  it("lets the holder re-claim to renew, with a custom lease", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await claimTask(ctx, t.id);
    clock.advance(10 * 60_000);
    const renewed = await claimTask(ctx, t.id, { leaseMinutes: 5 });
    expect(renewed.claim?.leaseUntil).toBe("2026-11-03T12:15:00.000Z");
  });

  it("only claims todo or in-progress tasks", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x", status: "backlog" });
    await expect(claimTask(ctx, t.id)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  // "Leases renew on any write by the holder", and handing a task back frees it for others.
  it("renews the lease on the holder's updates and drops it when moved back to todo", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await claimTask(ctx, t.id);
    clock.advance(20 * 60_000);
    const updated = await updateTask(ctx, t.id, { body: "progress" });
    expect(updated.claim?.leaseUntil).toBe("2026-11-03T12:50:00.000Z");
    const back = await updateTask(ctx, t.id, { status: "todo" });
    expect(back.claim).toBeNull();
    expect((await listTasks(ctx, { ready: true })).map((x) => x.id)).toEqual([t.id]);
  });

  it("does not renew another actor's lease on their update", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const claimed = await claimTask(ctx, t.id);
    const other = await otherActor(ctx);
    const updated = await updateTask(other, t.id, { body: "note" });
    expect(updated.claim).toEqual(claimed.claim);
  });
});

describe("releaseExpiredClaims", () => {
  // PLAN: "every brief clears expired leases", so work an agent abandoned becomes ready again
  // instead of sitting in in_progress with nobody on it.
  it("returns abandoned in-progress work to todo and leaves live claims alone", async () => {
    const { ctx, clock, store } = await setup();
    const abandoned = await createTask(ctx, { title: "abandoned" });
    await claimTask(ctx, abandoned.id, { leaseMinutes: 10 });
    const live = await createTask(ctx, { title: "live" });
    await claimTask(ctx, live.id, { leaseMinutes: 60 });
    const waiting = await createTask(ctx, { title: "waiting" });
    await claimTask(ctx, waiting.id, { leaseMinutes: 10 });
    await updateTask(ctx, waiting.id, { status: "review" });
    clock.advance(31 * 60_000);

    const released = await releaseExpiredClaims(ctx);
    expect(released.map((t) => [t.title, t.status, t.claim])).toEqual([
      ["abandoned", "todo", null],
      ["waiting", "review", null],
    ]);
    expect(store.activity.at(-1)).toMatchObject({ verb: "release", entityId: waiting.id });
    expect((await listTasks(ctx, { ready: true })).map((t) => t.id)).toEqual([abandoned.id]);
    const stillLive = await listTasks(ctx, { status: ["in_progress"] });
    expect(stillLive.map((t) => t.claim?.leaseUntil)).toEqual(["2026-11-03T13:00:00.000Z"]);
  });

  it("writes nothing when no lease has expired", async () => {
    const { ctx, store } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await claimTask(ctx, t.id);
    const before = store.activity.length;
    expect(await releaseExpiredClaims(ctx)).toEqual([]);
    expect(store.activity.length).toBe(before);
  });
});

async function otherActor(ctx: ServiceContext): Promise<ServiceContext> {
  const actor = await ensureActor(ctx, { name: "codex@main#2", kind: "agent", tool: "codex" });
  return { ...ctx, actorId: actor.id };
}
