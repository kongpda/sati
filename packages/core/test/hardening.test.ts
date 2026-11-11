import { describe, expect, it } from "vitest";
import {
  acquireLock,
  claimTask,
  completeTask,
  createFeature,
  createTask,
  deleteRecord,
  doctorChecks,
  ensureActor,
  importPlan,
  isSatiError,
  listLocks,
  listRecords,
  listTasks,
  pathsOverlap,
  releaseExpiredClaims,
  restoreRecord,
  type ServiceContext,
  undoActivity,
  updateTask,
  writeHandoff,
} from "../src/index.js";
import { setup } from "./support/setup.js";

async function as(ctx: ServiceContext, name: string, kind: "agent" | "human") {
  const actor = await ensureActor(ctx, {
    name,
    kind,
    tool: kind === "agent" ? "codex" : null,
    worktree: null,
  });
  return { ...ctx, actorId: actor.id };
}

describe("brace expansion is bounded", () => {
  // Untrusted globs: `{a,b}` x200 would expand to 2^200 strings and hang or exhaust memory.
  it("treats an over-cap or unexpandable stored pattern as overlapping instead of expanding it", () => {
    const bomb = "{a,b}".repeat(200);
    expect(pathsOverlap(bomb, "src/x.ts")).toBe(true);
    expect(pathsOverlap("src/{1..5000}", "docs/y.md")).toBe(true);
    // Normal braces still discriminate.
    expect(pathsOverlap("src/{a,b}/x.ts", "src/c/x.ts")).toBe(false);
  });

  it("refuses such a pattern in a lock, with a clear message", async () => {
    const { ctx } = await setup();
    await expect(acquireLock(ctx, { paths: ["{a,b}".repeat(200)] })).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("brace"),
    });
    await expect(acquireLock(ctx, { paths: ["src/{1..5000}"] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("refuses such a pattern in a feature's paths and tests", async () => {
    const { ctx } = await setup();
    await expect(createFeature(ctx, { title: "F", paths: ["{a,b}".repeat(200)] })).rejects.toThrow(
      /brace/,
    );
    await expect(createFeature(ctx, { title: "F", tests: ["x/{1..999}"] })).rejects.toThrow(
      /brace/,
    );
    await expect(
      createFeature(ctx, { title: "F", paths: ["src/{a,b}/**"] }),
    ).resolves.toBeDefined();
  });
});

describe("deleting a claimed task", () => {
  // Another agent's live work must not vanish, and a deleted task must not keep its locks.
  it("refuses an agent that is not the holder, but lets a person delete and frees the locks", async () => {
    const { ctx } = await setup();
    const other = await as(ctx, "other@main", "agent");
    const person = await as(ctx, "kim@main", "human");
    const t = await createTask(ctx, { title: "x" });
    await claimTask(ctx, t.id);
    await acquireLock(ctx, { paths: ["src/a.ts"], taskId: t.id });

    await expect(deleteRecord(other, "task", t.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await deleteRecord(person, "task", t.id);
    expect(await listLocks(ctx)).toHaveLength(0);
    expect((await restoreRecord(person, "task", t.id)).deletedAt).toBeNull();
  });

  it("lets the holder delete, and anyone once the lease has expired", async () => {
    const { ctx, clock } = await setup();
    const other = await as(ctx, "other@main", "agent");
    const mine = await createTask(ctx, { title: "mine" });
    await claimTask(ctx, mine.id);
    await deleteRecord(ctx, "task", mine.id);

    const stale = await createTask(ctx, { title: "stale" });
    await claimTask(ctx, stale.id);
    clock.advance(24 * 60 * 60_000);
    await deleteRecord(other, "task", stale.id);
  });
});

describe("importPlan limits", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `- [ ] task ${i}`).join("\n");

  // A dry run is how a person checks a plan before importing it. One that passes while the
  // import then refuses the file is worse than no dry run.
  it("refuses a secret or an over-long heading in a dry run, as the import does", async () => {
    const { ctx } = await setup();
    const key = `gh${"p_"}${"a1".repeat(18)}`;
    for (const markdown of [
      `# M\n- [ ] deploy with ${key}\n`,
      `# Release ${key}\n- [ ] ship\n`,
      `# ${"h".repeat(600)}\n- [ ] ship\n`,
    ]) {
      await expect(importPlan(ctx, { markdown, dryRun: true })).rejects.toMatchObject({
        code: "VALIDATION",
      });
      await expect(importPlan(ctx, { markdown })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(await listRecords(ctx, "task")).toHaveLength(0);
    expect(await listRecords(ctx, "milestone")).toHaveLength(0);
  });

  // A pasted huge file must not create thousands of rows; the dry run must warn the same way.
  it("refuses more than 500 tasks, in a dry run too", async () => {
    const { ctx } = await setup();
    const markdown = `# M\n${lines(501)}`;
    await expect(importPlan(ctx, { markdown, dryRun: true })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(importPlan(ctx, { markdown })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await listRecords(ctx, "task")).toHaveLength(0);
  });

  it("refuses more than 100 milestones", async () => {
    const { ctx } = await setup();
    const markdown = Array.from({ length: 101 }, (_, i) => `# H${i}\n- [ ] t${i}`).join("\n");
    await expect(importPlan(ctx, { markdown })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("names the source line of an over-long title", async () => {
    const { ctx } = await setup();
    const markdown = `# M\n- [ ] ok\n- [ ] ${"x".repeat(400)}`;
    await expect(importPlan(ctx, { markdown })).rejects.toThrow(/Line 3/);
  });

  it("gives each new milestone a distinct, increasing order", async () => {
    const { ctx } = await setup();
    await importPlan(ctx, { markdown: "# A\n- [ ] a\n# B\n- [ ] b\n# C\n- [ ] c" });
    const orders = (await listRecords(ctx, "milestone")).map((m) => m.order).sort();
    expect(orders).toEqual([0, 1, 2]);
  });
});

describe("task status review", () => {
  // Review without a completion record can never be approved; `complete` is the only way in.
  it("is refused through update, and complete still works", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const claimed = await claimTask(ctx, t.id);
    await expect(
      updateTask(ctx, t.id, { status: "review", token: claimed.claim?.token }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const done = await completeTask(ctx, t.id, {
      summary: "s",
      filesTouched: ["a.ts"],
      token: claimed.claim?.token,
    });
    expect(done.status).toBe("review");
  });
});

describe("expiry sweep", () => {
  // An expired claim's locks would otherwise block everyone until their own lease ran out.
  it("releases the holder's task locks along with the claim", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await claimTask(ctx, t.id, { leaseMinutes: 1 });
    await acquireLock(ctx, { paths: ["src/a.ts"], taskId: t.id, leaseMinutes: 1000 });
    clock.advance(5 * 60_000);
    await releaseExpiredClaims(ctx);
    expect(await listLocks(ctx)).toHaveLength(0);
  });
});

describe("handoff secrets", () => {
  it("refuses a handoff that contains a secret, as a note would", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await expect(
      writeHandoff(ctx, { taskId: t.id, done: "key sk-abcdefghijklmnopqrstuvwxyz123456" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("undo of claim changes", () => {
  // Replaying an old claim would steal or resurrect a lease without the fencing checks.
  it("refuses to undo an activity whose diff touches the claim", async () => {
    const { ctx, store, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const claimed = await claimTask(ctx, t.id);
    clock.advance(60_000); // a holder write renews the lease, so the diff includes the claim
    await updateTask(ctx, t.id, { priority: "high", token: claimed.claim?.token });
    const row = store.activity.find(
      (r) => r.entityId === t.id && r.verb === "update" && "claim" in r.diff,
    );
    expect(row).toBeDefined();
    await expect(undoActivity(ctx, row?.id ?? "")).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("more than 500 active tasks", () => {
  // A snapshot capped at 500 would leave the 501st expired claim and its checks unprocessed.
  it("sweeps and reports every expired claim", async () => {
    const { ctx, clock } = await setup();
    for (let i = 0; i < 502; i++) {
      const t = await createTask(ctx, { title: `t${i}` });
      await claimTask(ctx, t.id, { leaseMinutes: 1 });
    }
    clock.advance(5 * 60_000);
    const checks = await doctorChecks(ctx);
    expect(checks.find((c) => c.name === "claims")?.ok).toBe(false);
    expect(await releaseExpiredClaims(ctx)).toHaveLength(502);
  });
});

describe("validation messages", () => {
  // The same text reaches a person at the CLI and an agent over MCP, so it names the field and
  // the allowed values once, without Zod's labels. The issues stay whole in `details`.
  it("says the field, the allowed values and nothing twice", async () => {
    const { ctx } = await setup();
    const message = async (run: () => Promise<unknown>) => {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      if (!isSatiError(err)) throw new Error("expected a SatiError");
      expect(err.code).toBe("VALIDATION");
      expect(err.details).toHaveProperty("issues");
      return err.message;
    };
    expect(await message(() => createTask(ctx, { title: "x", priority: "hi" }))).toBe(
      "Invalid input: priority: expected one of low, medium, high, urgent",
    );
    expect(await message(() => listTasks(ctx, { status: ["nope"] }))).toMatch(
      /^Invalid input: status: expected one of backlog, todo, /u,
    );
    expect(await message(() => createTask(ctx, { title: "" }))).toBe(
      "Invalid input: title: must not be empty",
    );
    expect(await message(() => createTask(ctx, {}))).toBe(
      "Invalid input: title: expected string, received undefined",
    );
  });
});
