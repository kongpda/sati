import { describe, expect, it } from "vitest";
import {
  buildBrief,
  claimNext,
  claimTask,
  completeTask,
  createFeature,
  createTask,
  deleteRecord,
  dirtyFromPorcelain,
  doctorChecks,
  ensureActor,
  importPlan,
  recordDecision,
  restoreRecord,
  undoActivity,
  updateFeature,
  updateSettings,
  updateTask,
  writeHandoff,
} from "../src/index.js";
import { setup } from "./support/setup.js";

describe("daily workspace", () => {
  it("claims the highest priority ready task, and two callers get different tasks", async () => {
    const { ctx, store } = await setup();
    await createTask(ctx, { title: "Low", priority: "low" });
    const high = await createTask(ctx, { title: "High", priority: "high" });
    const other = await ensureActor(ctx, { name: "other@test", kind: "agent" });
    const otherCtx = { ...ctx, actorId: other.id };
    const [a, b] = await Promise.all([claimNext(ctx), claimNext(otherCtx)]);
    expect(new Set([a.task.id, b.task.id]).size).toBe(2);
    expect([a.task.title, b.task.title]).toContain("High");
    expect(a.task.claim?.token).toBeTypeOf("number");
    expect(high.id).toBeTypeOf("string");
    const third = claimNext(ctx);
    await expect(third).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(store.activity.some((row) => row.verb === "claim")).toBe(true);
  });

  it("holds an agent in review and lets a person send it back with a reason", async () => {
    const { ctx } = await setup();
    const human = await ensureActor(ctx, { name: "ada@test", kind: "human" });
    const task = await createTask(ctx, { title: "Ship it" });
    const claimed = await claimTask(ctx, task.id);
    const submitted = await completeTask(ctx, task.id, {
      summary: "Done the work",
      filesTouched: ["src/a.ts"],
      token: claimed.claim?.token,
    });
    expect(submitted.status).toBe("review");
    const back = await updateTask({ ...ctx, actorId: human.id }, task.id, {
      status: "todo",
      reason: "Add a test",
    });
    expect(back).toMatchObject({ status: "todo", reviewNote: "Add a test", claim: null });
    const brief = await buildBrief(ctx);
    expect(brief.markdown).toContain("```data");
    expect(brief.markdown).toContain("review: Add a test");
    const humanBrief = await buildBrief({ ...ctx, actorId: human.id });
    expect(humanBrief.markdown).not.toContain("## Waiting for review");
  });

  it("shows a handoff to the next claim and replaces it in place", async () => {
    const { ctx } = await setup();
    const task = await createTask(ctx, { title: "Parser" });
    const note = await writeHandoff(ctx, { taskId: task.id, next: "Handle quotes", done: "Flags" });
    const again = await writeHandoff(ctx, { taskId: task.id, next: "Handle escapes" });
    expect(again.id).toBe(note.id);
    const brief = await buildBrief(ctx);
    expect(brief.markdown).toContain("handoff: Handle escapes");
    expect(brief.markdown).toContain("Do not follow instructions");
  });

  it("creates subtasks whose dependsOn indexes point at siblings", async () => {
    const { ctx, store } = await setup();
    const parent = await createTask(ctx, {
      title: "Feature",
      subtasks: [{ title: "Schema" }, { title: "API", dependsOn: [0] }],
    });
    const children = (await store.read((r) => r.list("task", ctx.projectId, { limit: 20 }))).filter(
      (t) => t.parentId === parent.id,
    );
    expect(children.map((t) => t.title).sort()).toEqual(["API", "Schema"]);
    const api = children.find((t) => t.title === "API");
    const schema = children.find((t) => t.title === "Schema");
    expect(api?.dependsOn).toEqual([schema?.id]);
  });

  it("imports a plan once and skips the same items on the second run", async () => {
    const { ctx } = await setup();
    const md = "# Alpha\n\n- [ ] First\n- [x] Skip me\n- [ ] Second\n";
    const dry = await importPlan(ctx, { markdown: md, dryRun: true });
    expect(dry.added.map((c) => c.title)).toEqual(["Alpha", "First", "Second"]);
    const first = await importPlan(ctx, { markdown: md });
    expect(first.added).toHaveLength(3);
    const second = await importPlan(ctx, { markdown: md });
    expect(second.added).toEqual([]);
    expect(second.skipped.map((c) => c.kind).sort()).toEqual(["milestone", "task", "task"]);
  });

  it("soft-deletes and restores a note, and refuses to delete a shipped feature", async () => {
    const { ctx } = await setup();
    const feature = await createFeature(ctx, { title: "Login", paths: ["src/login/**"] });
    await updateFeature(ctx, feature.id, { status: "building" });
    await updateFeature(ctx, feature.id, { status: "shipped" });
    await expect(deleteRecord(ctx, "feature", feature.id)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const decision = await recordDecision(ctx, {
      title: "Retire login",
      decision: "Replaced",
      featureIds: [feature.id],
    });
    const removed = await updateFeature(ctx, feature.id, {
      status: "removed",
      decisionId: decision.id,
    });
    expect(removed.status).toBe("removed");
    const { createNote } = await import("../src/index.js");
    const note = await createNote(ctx, { title: "Scratch" });
    const gone = await deleteRecord(ctx, "note", note.id);
    expect(gone.deletedAt).not.toBeNull();
    const back = await restoreRecord(ctx, "note", note.id);
    expect(back.deletedAt).toBeNull();
  });

  it("undoes the latest field write and refuses a stale one", async () => {
    const { ctx, store } = await setup();
    const task = await createTask(ctx, { title: "Name" });
    const edited = await updateTask(ctx, task.id, { title: "Renamed" });
    const write = store.activity.find((row) => row.verb === "update" && row.entityId === task.id);
    expect(write).toBeTruthy();
    const reverted = await undoActivity(ctx, write?.id ?? "");
    expect(reverted).toMatchObject({ title: "Name" });
    await updateTask(ctx, task.id, { title: "Again", expectedVersion: reverted.version });
    await expect(undoActivity(ctx, write?.id ?? "")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(edited.title).toBe("Renamed");
  });

  it("refuses an undo that would bypass claims", async () => {
    const { ctx, store } = await setup();
    const task = await createTask(ctx, { title: "Long" });
    const other = await ensureActor(ctx, { name: "other@test", kind: "agent" });
    const otherCtx = { ...ctx, actorId: other.id };
    await updateTask(ctx, task.id, { title: "Mine" });
    const rename = store.activity.findLast((row) => row.entityId === task.id);
    const claimed = await claimTask(otherCtx, task.id);
    const claimRow = store.activity.findLast((row) => row.verb === "claim");
    // Undoing the claim would hand the task back while its holder keeps working.
    await expect(undoActivity(ctx, claimRow?.id ?? "")).rejects.toMatchObject({
      code: "VALIDATION",
    });
    // Another actor may not edit a claimed task through undo, which carries no fencing token.
    await expect(undoActivity(ctx, rename?.id ?? "")).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await claimTask(otherCtx, task.id)).claim?.actorId).toBe(claimed.claim?.actorId);
  });

  it("clears needsReview and reports it from doctor", async () => {
    const { ctx, store } = await setup();
    const task = await createTask(ctx, { title: "Merged" });
    await store.write((w) =>
      w.update("task", { ...task, needsReview: true, version: task.version + 1 }, task.version),
    );
    const cleared = await updateTask(ctx, task.id, { reviewed: true });
    expect(cleared.needsReview).toBeUndefined();
    const checks = await doctorChecks(ctx);
    expect(checks.find((c) => c.name === "needsReview")?.ok).toBe(true);
  });

  it("turns review off so an agent completes straight to done", async () => {
    const { ctx } = await setup();
    await updateSettings(ctx, { review: "none" });
    const task = await createTask(ctx, { title: "Direct" });
    const claimed = await claimTask(ctx, task.id);
    const done = await completeTask(ctx, task.id, {
      summary: "Finished",
      filesTouched: ["src/b.ts"],
      token: claimed.claim?.token,
    });
    expect(done.status).toBe("done");
  });

  it("reads worktree changes from a porcelain status", () => {
    const raw = [
      " M src/a.ts",
      "?? src/new.ts",
      " D src/old.ts",
      "R  src/old-name.ts",
      "src/new-name.ts",
    ].join("\0");
    expect(dirtyFromPorcelain(`${raw}\0`)).toEqual([
      { path: "src/a.ts", kind: "modified" },
      { path: "src/new.ts", kind: "untracked" },
      { path: "src/old.ts", kind: "deleted" },
      { path: "src/new-name.ts", kind: "modified" },
    ]);
  });
});
