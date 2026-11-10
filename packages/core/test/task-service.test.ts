import { describe, expect, it } from "vitest";
import {
  claimTask,
  completeTask,
  createFeature,
  createMilestone,
  createTask,
  ensureActor,
  getRecord,
  listTasks,
  releaseExpiredClaims,
  type ServiceContext,
  updateSettings,
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

  // PLAN Phase 5b: starting work through update claims the task, so it is not free for others.
  it("claims the task for the caller when update moves it to in_progress", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const u = await updateTask(ctx, t.id, { status: "in_progress" });
    expect(u.claim).toMatchObject({ actorId: ctx.actorId, token: u.version });
    // Writes now need the token, as after task_claim.
    await expect(updateTask(ctx, t.id, { body: "y" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await updateTask(ctx, t.id, { body: "y", token: u.version })).body).toBe("y");
    // Back to todo drops the claim again.
    expect((await updateTask(ctx, t.id, { status: "todo", token: u.version })).claim).toBeNull();
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
    const { claim: ct } = await updateTask(ctx, t.id, { status: "in_progress" });
    const tokt = ct?.token;
    await expect(
      completeTask(ctx, t.id, { summary: "ok", filesTouched: [], token: tokt }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(completeTask(ctx, t.id, { summary: "ok", token: tokt })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  // Why: an absolute path was stored as written, so the guard, reviews and `changes` never
  // matched it to a repo file; context cards already refused one.
  it("refuses absolute paths in filesTouched and feature paths, and tidies ./", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const { claim } = await updateTask(ctx, t.id, { status: "in_progress" });
    const token = claim?.token;
    await expect(
      completeTask(ctx, t.id, { summary: "ok", filesTouched: ["/Users/me/repo/a.ts"], token }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createFeature(ctx, { title: "F", paths: ["/abs/src/**"] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(createFeature(ctx, { title: "F", tests: ["../x.test.ts"] })).rejects.toMatchObject(
      { code: "VALIDATION" },
    );
    const done = await completeTask(ctx, t.id, { summary: "ok", filesTouched: ["./a.ts"], token });
    expect(done.completion?.filesTouched).toEqual(["a.ts"]);
  });

  it("needs no files in a general project, where work is often not in files", async () => {
    const { ctx } = await setup();
    await updateSettings(ctx, { kind: "general" });
    const t = await createTask(ctx, { title: "Call the caterer" });
    const { claim: ct } = await updateTask(ctx, t.id, { status: "in_progress" });
    const tokt = ct?.token;
    const done = await completeTask(ctx, t.id, { summary: "Booked for 80 guests.", token: tokt });
    expect(done.completion?.filesTouched).toEqual([]);
  });

  it("records who finished it, releases the claim and unblocks dependents", async () => {
    const { ctx, actor, store } = await setup();
    await updateSettings(ctx, { review: "none" });
    const dep = await createTask(ctx, { title: "dep" });
    const next = await createTask(ctx, { title: "next", dependsOn: [dep.id] });
    expect((await listTasks(ctx, { ready: true })).map((t) => t.id)).toEqual([dep.id]);

    const { claim: cdep } = await updateTask(ctx, dep.id, { status: "in_progress" });
    const tokdep = cdep?.token;
    const finished = await completeTask(ctx, dep.id, { ...done, token: tokdep });
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
    await updateSettings(ctx, { review: "none" });
    const t = await createTask(ctx, { title: "x" });
    const { claim: ct } = await updateTask(ctx, t.id, { status: "in_progress" });
    const tokt = ct?.token;
    await completeTask(ctx, t.id, { ...done, token: tokt });
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

describe("task milestones", () => {
  it("lists a milestone's own tasks and its features' tasks, and checks the link", async () => {
    const { ctx } = await setup();
    const launch = await createMilestone(ctx, { title: "Spring launch" });
    const other = await createMilestone(ctx, { title: "Autumn" });
    const feature = await createFeature(ctx, { title: "Tickets", milestoneId: launch.id });
    const venue = await createTask(ctx, {
      title: "Book the venue",
      milestoneId: launch.id,
      subtasks: [{ title: "Visit two halls" }],
    });
    await createTask(ctx, { title: "Sell tickets", featureId: feature.id });
    await createTask(ctx, { title: "Plan autumn", milestoneId: other.id });
    await createTask(ctx, { title: "Unplanned" });
    const titles = async (input: object) =>
      (await listTasks(ctx, { milestoneId: launch.id, ...input })).map((t) => t.title).sort();
    // Subtasks join their parent's plan.
    expect(await titles({})).toEqual(["Book the venue", "Sell tickets", "Visit two halls"]);
    expect(await titles({ ready: true })).toEqual([
      "Book the venue",
      "Sell tickets",
      "Visit two halls",
    ]);
    // Clearing the link takes the task out of the plan; a missing milestone is refused.
    await updateTask(ctx, venue.id, { milestoneId: null });
    expect(await titles({})).toEqual(["Sell tickets", "Visit two halls"]);
    await expect(
      createTask(ctx, { title: "x", milestoneId: "mil_01M6GMFKG0QFF1E44RZG05GC7W" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("task planning fields", () => {
  it("keeps an assignee this database has never seen, but checks new ones", async () => {
    const { ctx, actor, store } = await setup();
    // As in a teammate's clone: the snapshot names an actor that only exists over there.
    const elsewhere = "actr_01M6G33B1G2RYG4BE041CCNFNK";
    const t = await createTask(ctx, { title: "Book venue" });
    await store.write((w) =>
      w.update("task", { ...t, assigneeIds: [elsewhere], version: t.version + 1 }, t.version),
    );
    const kept = await updateTask(ctx, t.id, { assigneeIds: [elsewhere, actor.id] });
    expect(kept.assigneeIds).toEqual([elsewhere, actor.id]);
    await expect(
      updateTask(ctx, t.id, { assigneeIds: [elsewhere, "actr_01M6G33B1G2RYG4BE041CCNFNM"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("stores a due date, assignees and a checklist only once set, and checks them", async () => {
    const { ctx, actor } = await setup();
    const plain = await createTask(ctx, { title: "No plan yet" });
    // Untouched tasks keep the old record shape, so older .sati/ files read the same.
    expect(Object.keys(plain)).not.toContain("dueDate");
    expect(Object.keys(plain)).not.toContain("checklist");
    const t = await createTask(ctx, {
      title: "Print flyers",
      dueDate: "2026-12-04",
      assigneeIds: [actor.id],
      checklist: [{ text: "Proof the design", done: false }],
    });
    expect(t).toMatchObject({ dueDate: "2026-12-04", assigneeIds: [actor.id] });
    const ticked = await updateTask(ctx, t.id, {
      checklist: [{ text: "Proof the design", done: true }],
      dueDate: null,
      expectedVersion: t.version,
    });
    expect(ticked).toMatchObject({ checklist: [{ done: true }], dueDate: null });
    await expect(
      createTask(ctx, { title: "x", assigneeIds: ["actr_01M0000000000000000000000Z"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createTask(ctx, { title: "x", dueDate: "2026-02-30" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      createTask(ctx, { title: "x", checklist: [{ text: "  ", done: false }] }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("filters by due date (inclusive, undated left out) and by assignee", async () => {
    const { ctx, actor } = await setup();
    const other = await ensureActor(ctx, { name: "codex@b", kind: "agent", tool: "codex" });
    await createTask(ctx, { title: "thu", dueDate: "2026-12-03", assigneeIds: [other.id] });
    await createTask(ctx, { title: "fri", dueDate: "2026-12-04", assigneeIds: [actor.id] });
    await createTask(ctx, { title: "sat", dueDate: "2026-12-05", assigneeIds: [actor.id] });
    await createTask(ctx, { title: "someday" });
    const titles = async (q: Record<string, unknown>) =>
      (await listTasks(ctx, q)).map((t) => t.title).sort();
    expect(await titles({ dueBy: "2026-12-04" })).toEqual(["fri", "thu"]);
    expect(await titles({ assigneeId: actor.id })).toEqual(["fri", "sat"]);
    expect(await titles({ assigneeId: actor.id, dueBy: "2026-12-04", ready: true })).toEqual([
      "fri",
    ]);
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
      token: 2,
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
    const { claim } = await claimTask(ctx, t.id);
    const token = claim?.token;
    clock.advance(20 * 60_000);
    const updated = await updateTask(ctx, t.id, { body: "progress", token });
    expect(updated.claim).toMatchObject({ leaseUntil: "2026-11-03T12:50:00.000Z", token });
    const back = await updateTask(ctx, t.id, { status: "todo", token });
    expect(back.claim).toBeNull();
    expect((await listTasks(ctx, { ready: true })).map((x) => x.id)).toEqual([t.id]);
  });

  // PLAN Phase 5b: the token is readable with `task show`, so it alone must not let another
  // actor write. Only the holder writes, and the claim stays as it was.
  it("refuses another actor's write even with the holder's token", async () => {
    const { ctx, store } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const claimed = await claimTask(ctx, t.id);
    const other = await otherActor(ctx);
    const token = claimed.claim?.token;
    await expect(updateTask(other, t.id, { body: "note", token })).rejects.toMatchObject({
      code: "CONFLICT",
      hint: expect.stringContaining("take-over"),
    });
    await expect(
      completeTask(other, t.id, { summary: "Not mine", filesTouched: ["a.ts"], token }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await store.read((r) => r.get("task", t.id));
    expect(after).toMatchObject({ body: "", claim: claimed.claim });
  });
});

describe("fencing tokens", () => {
  // PLAN review fix 2: a paused agent loses its lease, another claims the task, then the first
  // resumes. Its late write must be refused, or it overwrites the new holder's work.
  it("refuses a late write from an agent whose lease expired and was taken over", async () => {
    const { ctx: a, clock } = await setup();
    const t = await createTask(a, { title: "x" });
    const aToken = (await claimTask(a, t.id)).claim?.token;
    clock.advance(31 * 60_000);
    const b = await otherActor(a);
    const bToken = (await claimTask(b, t.id)).claim?.token;
    expect(bToken).not.toBe(aToken);
    await updateTask(b, t.id, { body: "B's work", token: bToken });

    await expect(
      updateTask(a, t.id, { body: "A's stale work", token: aToken }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("stale") });
    await expect(
      completeTask(a, t.id, { summary: "late", filesTouched: ["a.ts"], token: aToken }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await getRecord(a, "task", t.id)).toMatchObject({
      body: "B's work",
      status: "in_progress",
      claim: { actorId: b.actorId, token: bToken },
    });
  });

  // Holder-only fencing covers completion: after its lease ran out, the holder may still finish
  // while nobody else has claimed the task, because its token is still the current one.
  it("lets the holder complete after its lease ran out when nobody took the task", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "Long job" });
    const token = (await claimTask(ctx, t.id)).claim?.token;
    clock.advance(45 * 60_000);
    const done = await completeTask(ctx, t.id, { summary: "Done", filesTouched: ["a.ts"], token });
    expect(["review", "done"]).toContain(done.status);
  });

  it("refuses a write without the token while claimed, and a token once the claim is gone", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const token = (await claimTask(ctx, t.id, { leaseMinutes: 10 })).claim?.token;
    await expect(updateTask(ctx, t.id, { body: "no token" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("needs the claim's fencing token"),
    });

    // The lease expired and the brief released it: the old token is now stale too.
    clock.advance(11 * 60_000);
    await releaseExpiredClaims(ctx);
    await expect(updateTask(ctx, t.id, { body: "late", token })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // An unclaimed task needs no token.
    expect((await updateTask(ctx, t.id, { body: "planning" })).body).toBe("planning");
  });

  // Every claim gets a new token, even when the same task is claimed again after a release.
  it("never reissues an old token", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const tokens: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const { claim } = await claimTask(ctx, t.id);
      tokens.push(claim?.token);
      await updateTask(ctx, t.id, { status: "todo", token: claim?.token });
    }
    expect(new Set(tokens).size).toBe(3);
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
    const { claim } = await claimTask(ctx, waiting.id, { leaseMinutes: 10 });
    await updateTask(ctx, waiting.id, { status: "blocked", token: claim?.token });
    clock.advance(31 * 60_000);

    const released = await releaseExpiredClaims(ctx);
    expect(released.map((t) => [t.title, t.status, t.claim])).toEqual([
      ["abandoned", "todo", null],
      ["waiting", "blocked", null],
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
