import { describe, expect, it } from "vitest";
import {
  acquireLock,
  buildBrief,
  claimTask,
  createTask,
  ensureActor,
  listLocks,
  listTasks,
  markWaiting,
  shortHandle,
  taskRow,
  undoActivity,
  updateTask,
} from "../src/index.js";
import { setup } from "./support/setup.js";

// Effort lets an agent hand quick, mechanical tasks to a subagent on a cheaper model.
describe("task effort", () => {
  it("filters by effort, counting an unset effort as standard, in the ready queue too", async () => {
    const { ctx } = await setup();
    await createTask(ctx, { title: "rename", effort: "light" });
    await createTask(ctx, { title: "design", effort: "deep" });
    await createTask(ctx, { title: "plain" });
    await createTask(ctx, { title: "said standard", effort: "standard" });
    const titles = async (q: Record<string, unknown>) =>
      (await listTasks(ctx, q)).map((t) => t.title).sort();
    expect(await titles({ effort: "light" })).toEqual(["rename"]);
    expect(await titles({ effort: "light", ready: true })).toEqual(["rename"]);
    // Old tasks have no effort; leaving them out of "standard" would hide most of the queue.
    expect(await titles({ effort: "standard" })).toEqual(["plain", "said standard"]);
    expect(await titles({ effort: "standard", ready: true })).toEqual(["plain", "said standard"]);
    await expect(listTasks(ctx, { effort: "trivial" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  // A new task carries `effort: null` like every other empty field; the `.sati/` file leaves it
  // out (EMPTY_FIELDS), so an older sati never sees the key.
  it("is shown only once set, and null clears it", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    expect(t.effort).toBeNull();
    expect("effort" in taskRow(t)).toBe(false);
    const light = await updateTask(ctx, t.id, { effort: "light" });
    expect(taskRow(light).effort).toBe("light");
    const cleared = await updateTask(ctx, t.id, { effort: null });
    expect(cleared.effort).toBeNull();
    expect("effort" in taskRow(cleared)).toBe(false);
  });

  // The brief is where an agent picks work, so it must see which tasks it can hand off.
  it("shows a non-standard effort in the brief, and nothing for standard", async () => {
    const { ctx } = await setup();
    const light = await createTask(ctx, { title: "Fix a typo", effort: "light" });
    const plain = await createTask(ctx, { title: "Add login", effort: "standard" });
    const md = (await buildBrief(ctx)).markdown;
    expect(md).toContain(`${shortHandle(light.id)} [medium, light] Fix a typo`);
    expect(md).toContain(`${shortHandle(plain.id)} [medium] Add login`);
  });
});

describe("task locks follow the claim", () => {
  // A lock that lapses while its task is still being worked on lets another agent in.
  it("renews the holder's live task locks when the holder writes to the task", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const claimed = await claimTask(ctx, t.id);
    const { lock } = await acquireLock(ctx, { paths: ["src/a.ts"], taskId: t.id });
    const untagged = (await acquireLock(ctx, { paths: ["src/b.ts"] })).lock;
    clock.advance(20 * 60_000);
    await updateTask(ctx, t.id, { body: "progress", token: claimed.claim?.token });
    const after = await listLocks(ctx);
    const until = (id: string) => after.find((l) => l.id === id)?.leaseUntil;
    expect(until(lock.id)).toBe("2026-11-03T12:50:00.000Z");
    expect(until(untagged.id)).toBe(untagged.leaseUntil);

    clock.advance(20 * 60_000);
    await markWaiting(ctx, { taskId: t.id, waiting: { text: "Which tier?" } });
    expect((await listLocks(ctx)).find((l) => l.id === lock.id)?.leaseUntil).toBe(
      "2026-11-03T13:10:00.000Z",
    );
  });

  it("does not revive an expired lock", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    await claimTask(ctx, t.id, { leaseMinutes: 120 });
    const { lock } = await acquireLock(ctx, {
      paths: ["src/a.ts"],
      taskId: t.id,
      leaseMinutes: 5,
    });
    clock.advance(10 * 60_000);
    await claimTask(ctx, t.id);
    expect((await listLocks(ctx)).some((l) => l.id === lock.id)).toBe(false);
  });

  // Completing a task frees its locks; tagged with another agent's task, a lock would not be.
  it("refuses a lock tagged with a task another actor holds", async () => {
    const { ctx } = await setup();
    const other = await ensureActor(ctx, { name: "codex@b", kind: "agent", tool: "codex" });
    const octx = { ...ctx, actorId: other.id };
    const t = await createTask(ctx, { title: "theirs" });
    await claimTask(octx, t.id);
    await expect(acquireLock(ctx, { paths: ["src/a.ts"], taskId: t.id })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { holder: other.id },
    });
    // Unclaimed, or the caller's own: allowed.
    const free = await createTask(ctx, { title: "free" });
    await expect(acquireLock(ctx, { paths: ["src/b.ts"], taskId: free.id })).resolves.toBeDefined();
  });

  // A status change that ends the claim ends its locks, as release and complete do; otherwise
  // the paths stay closed to everyone until the lease runs out.
  it("frees the task's locks when a status change drops the claim", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const claimed = await claimTask(ctx, t.id);
    const { lock } = await acquireLock(ctx, { paths: ["src/a.ts"], taskId: t.id });
    await updateTask(ctx, t.id, { status: "todo", token: claimed.claim?.token });
    expect((await listLocks(ctx)).some((l) => l.id === lock.id)).toBe(false);
  });

  // The log drops `from` for a field that was first set, so undo once skipped it and still
  // reported success.
  it("undo removes a field the change first set", async () => {
    const { ctx, store } = await setup();
    // A task saved before `effort` existed has no key, so the log has no `from` for it.
    const made = await createTask(ctx, { title: "x" });
    const t = await ctx.store.write(async (w) => {
      const { effort: _none, ...old } = made;
      await w.update("task", old, made.version);
      return old;
    });
    await updateTask(ctx, t.id, { effort: "deep", title: "y" });
    const write = store.activity.find((row) => row.verb === "update" && row.entityId === t.id);
    const back = await undoActivity(ctx, write?.id ?? "");
    expect(back).toMatchObject({ title: "x" });
    expect("effort" in back).toBe(false);
  });
});
