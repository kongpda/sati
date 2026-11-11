import { describe, expect, it } from "vitest";
import {
  acquireLock,
  buildBrief,
  claimTask,
  completeTask,
  createTask,
  ensureActor,
  leanCleanup,
  listLocks,
  releaseLock,
  SatiError,
  type ServiceContext,
  shortHandle,
} from "../src/index.js";
import { setup } from "./support/setup.js";

async function otherActor(ctx: ServiceContext): Promise<ServiceContext> {
  const actor = await ensureActor(ctx, { name: "codex@main#2", kind: "agent", tool: "codex" });
  return { ...ctx, actorId: actor.id };
}

async function conflictOf(p: Promise<unknown>): Promise<SatiError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SatiError);
  expect((err as SatiError).code).toBe("CONFLICT");
  return err as SatiError;
}

describe("acquireLock", () => {
  it("stores normalised paths with a lease and logs one create row", async () => {
    const { ctx, store, actor } = await setup();
    const before = store.activity.length;
    const { lock, warnings } = await acquireLock(ctx, {
      paths: ["./src/billing/", "src/billing"],
      reason: "refactor",
    });
    expect(lock).toMatchObject({
      paths: ["src/billing"],
      mode: "exclusive",
      actorId: actor.id,
      taskId: null,
      leaseUntil: "2026-11-03T12:30:00.000Z",
    });
    expect(warnings).toEqual([]);
    expect(store.activity.slice(before)).toEqual([
      expect.objectContaining({ verb: "create", entity: "lock", entityId: lock.id }),
    ]);
  });

  // The point of an exclusive lock: a second agent cannot take overlapping paths.
  it("refuses another agent's overlapping lock with CONFLICT naming the holder", async () => {
    const { ctx } = await setup();
    const held = await acquireLock(ctx, { paths: ["src/billing/**"] });
    const other = await otherActor(ctx);
    const err = await conflictOf(acquireLock(other, { paths: ["src/billing/invoice.ts"] }));
    expect(err.message).toContain("claude-code@main#1");
    expect(err.details).toMatchObject({
      conflicts: [{ lockId: held.lock.id, paths: [["src/billing/invoice.ts", "src/billing/**"]] }],
    });
    // A shared request is blocked too: the existing lock is exclusive.
    await conflictOf(acquireLock(other, { paths: ["src/billing"], mode: "shared" }));
    // Disjoint paths are fine.
    expect((await acquireLock(other, { paths: ["src/auth/**"] })).lock.paths).toEqual([
      "src/auth/**",
    ]);
  });

  it("an exclusive request is blocked by another agent's shared lock", async () => {
    const { ctx } = await setup();
    await acquireLock(ctx, { paths: ["docs"], mode: "shared" });
    await conflictOf(acquireLock(await otherActor(ctx), { paths: ["docs/a.md"] }));
  });

  // PLAN: "shared only warns".
  it("shared over shared succeeds and returns the overlap as a warning", async () => {
    const { ctx } = await setup();
    const held = await acquireLock(ctx, { paths: ["docs/**"], mode: "shared" });
    const r = await acquireLock(await otherActor(ctx), { paths: ["docs/a.md"], mode: "shared" });
    expect(r.warnings).toEqual([expect.objectContaining({ lockId: held.lock.id, mode: "shared" })]);
  });

  // A list page holds 500 rows; a conflicting lock past the first page must still be found.
  it("finds a conflict behind more than one page of locks", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 500; i++) await acquireLock(ctx, { paths: [`pkg/${i}`] });
    await acquireLock(ctx, { paths: ["src"] });
    await conflictOf(acquireLock(await otherActor(ctx), { paths: ["src/a.ts"] }));
    expect(await listLocks(ctx)).toHaveLength(501);
  }, 30_000); // 501 acquires take about 1 s here; shared CI runners have been 5x slower.

  it("my own locks never conflict with each other", async () => {
    const { ctx } = await setup();
    await acquireLock(ctx, { paths: ["src"] });
    expect((await acquireLock(ctx, { paths: ["src/a.ts"] })).warnings).toEqual([]);
  });

  it("an expired lock no longer blocks, and is released by the next acquire", async () => {
    const { ctx, clock, store } = await setup();
    const old = await acquireLock(ctx, { paths: ["src"], leaseMinutes: 5 });
    clock.advance(5 * 60_000);
    const other = await otherActor(ctx);
    await acquireLock(other, { paths: ["src/a.ts"] });
    expect(store.activity.at(-2)).toMatchObject({ verb: "release", entityId: old.lock.id });
    expect((await listLocks(ctx)).map((l) => l.paths)).toEqual([["src/a.ts"]]);
  });

  // Until the next lock is taken, an expired lock stays and `doctor` fails on it. The cleanup
  // must release it, leave live locks alone, and log the release.
  it("the lean cleanup releases expired locks only, and logs each", async () => {
    const { ctx, clock, store } = await setup();
    await acquireLock(ctx, { paths: ["docs"], leaseMinutes: 60 });
    const old = await acquireLock(ctx, { paths: ["src"], leaseMinutes: 5 });
    clock.advance(5 * 60_000);
    expect(await leanCleanup(ctx, [])).toEqual({ locks: 1, cards: [] });
    expect(store.activity.at(-1)).toMatchObject({ verb: "release", entityId: old.lock.id });
    expect((await listLocks(ctx)).map((l) => l.paths)).toEqual([["docs"]]);
  });

  it("rejects paths outside the repo and unknown tasks", async () => {
    const { ctx } = await setup();
    await expect(acquireLock(ctx, { paths: ["/etc"] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(acquireLock(ctx, { paths: [] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      acquireLock(ctx, { paths: ["src"], taskId: "tsk_01M6G33B1G2RYG4BE041CCNFNK" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("releaseLock", () => {
  it("the holder releases; the paths are free again", async () => {
    const { ctx, store } = await setup();
    const { lock } = await acquireLock(ctx, { paths: ["src"] });
    const released = await releaseLock(ctx, lock.id);
    expect(released.deletedAt).not.toBeNull();
    expect(store.activity.at(-1)).toMatchObject({ verb: "release", entityId: lock.id });
    expect(await listLocks(ctx)).toEqual([]);
    await acquireLock(await otherActor(ctx), { paths: ["src"] });
  });

  // PLAN: "lock force-releases are always logged with the actor".
  it("another agent needs force, and the forced release is logged under that agent", async () => {
    const { ctx, store } = await setup();
    const { lock } = await acquireLock(ctx, { paths: ["src"] });
    const other = await otherActor(ctx);
    await conflictOf(releaseLock(other, lock.id));
    await releaseLock(other, lock.id, { force: true });
    expect(store.activity.at(-1)).toMatchObject({
      verb: "release",
      entityId: lock.id,
      actorId: other.actorId,
    });
  });

  it("anyone may release an expired lock", async () => {
    const { ctx, clock } = await setup();
    const { lock } = await acquireLock(ctx, { paths: ["src"], leaseMinutes: 1 });
    clock.advance(60_000);
    expect((await releaseLock(await otherActor(ctx), lock.id)).deletedAt).not.toBeNull();
  });
});

describe("locks and tasks", () => {
  // PLAN: "`task_complete` ... releases locks".
  it("completing a task releases my locks tied to it, and only those", async () => {
    const { ctx } = await setup();
    const task = await createTask(ctx, { title: "Billing" });
    const { claim } = await claimTask(ctx, task.id);
    await acquireLock(ctx, { paths: ["src/billing"], taskId: task.id });
    const unrelated = await acquireLock(ctx, { paths: ["docs"] });
    await completeTask(ctx, task.id, {
      summary: "done",
      filesTouched: ["src/billing/a.ts"],
      token: claim?.token,
    });
    expect((await listLocks(ctx)).map((l) => l.id)).toEqual([unrelated.lock.id]);
  });

  it("the brief lists other agents' live locks, not mine", async () => {
    const { ctx } = await setup();
    const other = await otherActor(ctx);
    const theirs = await acquireLock(other, { paths: ["src/billing/**"], reason: "x" });
    await acquireLock(ctx, { paths: ["docs"] });
    const md = (await buildBrief(ctx)).markdown;
    expect(md).toContain("## Locked by other agents");
    expect(md).toContain(
      `- ${shortHandle(theirs.lock.id)} exclusive src/billing/** by codex@main#2 until 12:30Z`,
    );
    expect(md).not.toContain("docs");
    const theirBrief = (await buildBrief(other)).markdown;
    expect(theirBrief).toContain("exclusive docs by claude-code@main#1");
    expect(theirBrief).not.toContain(shortHandle(theirs.lock.id));
  });
});
