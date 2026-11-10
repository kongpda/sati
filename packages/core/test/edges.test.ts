import { describe, expect, it } from "vitest";
import {
  acquireLock,
  buildBrief,
  claimTask,
  completeTask,
  createFeature,
  createMilestone,
  createNote,
  createTask,
  deleteRecord,
  dirtyFromPorcelain,
  doctorChecks,
  ensureActor,
  getProject,
  importRecords,
  isSatiError,
  listAll,
  recordDecision,
  restoreRecord,
  undoActivity,
  updateFeature,
  updateNote,
  updateSettings,
  updateTask,
} from "../src/index.js";
import { MemoryStore } from "./support/memory-store.js";
import { setup } from "./support/setup.js";

const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return isSatiError(err) ? err.code : "other";
  }
};

describe("edge branches", () => {
  it("classifies porcelain, including short records and renames", () => {
    const rows = dirtyFromPorcelain(
      " M file.ts\0 D gone.ts\0?? new.ts\0R  old.ts\0renamed.ts\0C  a.ts\0b.ts\0 T typed.ts\0x\0R  lonely",
    );
    expect(rows.map((row) => row.kind)).toEqual([
      "modified",
      "deleted",
      "untracked",
      "modified",
      "modified",
      "modified",
      "modified",
    ]);
    expect(rows[3]?.path).toBe("renamed.ts");
    expect(rows.at(-1)?.path).toBe("lonely");
  });

  it("refuses bad deletes, restores and undos", async () => {
    const { ctx, store } = await setup();
    const task = await createTask(ctx, { title: "One" });
    expect(await code(() => deleteRecord(ctx, "lock", "lock_x"))).toBe("USAGE");
    expect(await code(() => deleteRecord(ctx, "task", "tsk_missing"))).toBe("NOT_FOUND");
    await deleteRecord(ctx, "task", task.id);
    expect(await code(() => deleteRecord(ctx, "task", task.id))).toBe("NOT_FOUND");
    await restoreRecord(ctx, "task", task.id);
    expect(await code(() => restoreRecord(ctx, "task", task.id))).toBe("VALIDATION");
    expect(await code(() => restoreRecord(ctx, "milestone", "mst_x"))).toBe("USAGE");
    expect(await code(() => undoActivity(ctx, "act_missing"))).toBe("NOT_FOUND");
    const created = await store.read((r) => r.listActivity(ctx.projectId, { limit: 50 }));
    const createRow = created.find((row) => row.verb === "create" && row.entityId === task.id);
    expect(createRow).toBeDefined();
    await updateTask(ctx, task.id, { title: "Changed" });
    expect(await code(() => undoActivity(ctx, createRow?.id ?? ""))).toBe("CONFLICT");
    await store.write(async (w) => {
      await w.appendActivity({
        id: "act_01EDGE000000000000000000",
        projectId: ctx.projectId,
        actorId: ctx.actorId,
        verb: "update",
        entity: "nope",
        entityId: task.id,
        diff: {},
        branch: null,
        at: "2026-11-03T12:00:00.000Z",
      });
      await w.appendActivity({
        id: "act_01EDGE000000000000000001",
        projectId: ctx.projectId,
        actorId: ctx.actorId,
        verb: "update",
        entity: "task",
        entityId: task.id,
        diff: { noise: "not-a-pair" },
        branch: null,
        at: "2026-11-03T12:00:01.000Z",
      });
    });
    expect(await code(() => undoActivity(ctx, "act_01EDGE000000000000000000"))).toBe("VALIDATION");
    expect(await code(() => undoActivity(ctx, "act_01EDGE000000000000000001"))).toBe("VALIDATION");
  });

  // Review WP2.2: undo wrote old values back without the checks a normal edit runs, so it could
  // make a status move the state machine forbids or link a task to a deleted record.
  it("refuses an undo that would break the state machine or restore a dead link", async () => {
    const { ctx, store } = await setup();
    const rows = () => store.read((r) => r.listActivity(ctx.projectId, { limit: 50 }));
    const lastRow = async (entityId: string, field: string) =>
      (await rows()).find((row) => row.entityId === entityId && Object.hasOwn(row.diff, field))
        ?.id ?? "";

    // building -> removed is allowed; removed -> building is not, so undo must refuse it.
    const feature = await createFeature(ctx, { title: "Search", status: "building" });
    await updateFeature(ctx, feature.id, { status: "removed" });
    const removal = await lastRow(feature.id, "status");
    expect(await code(() => undoActivity(ctx, removal))).toBe("CONFLICT");

    // Moving a task from feature A to B, then deleting A: undo would link the task to a deleted A.
    const a = await createFeature(ctx, { title: "A" });
    const b = await createFeature(ctx, { title: "B" });
    const task = await createTask(ctx, { title: "Linked", featureId: a.id });
    await updateTask(ctx, task.id, { featureId: b.id });
    const move = await lastRow(task.id, "featureId");
    await deleteRecord(ctx, "feature", a.id);
    expect(await code(() => undoActivity(ctx, move))).toBe("CONFLICT");
    // With A back, the same undo goes through.
    await restoreRecord(ctx, "feature", a.id);
    expect(await undoActivity(ctx, move)).toMatchObject({ featureId: a.id });
  });

  it("lets an agent close review once the gate is off", async () => {
    const { ctx } = await setup();
    const task = await createTask(ctx, { title: "Gate" });
    const claimed = await claimTask(ctx, task.id);
    const review = await completeTask(ctx, task.id, {
      summary: "shipped",
      filesTouched: ["a.ts"],
      token: claimed.claim?.token,
    });
    expect(review.status).toBe("review");
    expect(await code(() => updateTask(ctx, task.id, { status: "done" }))).toBe(
      "INVALID_TRANSITION",
    );
    await updateSettings(ctx, { review: "none" });
    const done = await updateTask(ctx, task.id, { status: "done" });
    expect(done.status).toBe("done");
  });

  // PLAN Phase 5b: limits are bytes. Khmer is 3 bytes a character, so 40,000 of them is 120 KB.
  it("caps bodies at 100 KB of UTF-8 and a subtask batch at 1 MB", async () => {
    const { ctx } = await setup();
    const khmer = (n: number) => "ក".repeat(n);
    expect(await code(() => createNote(ctx, { title: "x", body: khmer(40_000) }))).toBe(
      "VALIDATION",
    );
    expect(await code(() => createNote(ctx, { title: "x", body: khmer(33_000) }))).toBe("ok");
    // Emoji are surrogate pairs: 2 characters, 4 bytes.
    expect(await code(() => createTask(ctx, { title: "x", body: "😀".repeat(25_001) }))).toBe(
      "VALIDATION",
    );
    const sub = (i: number) => ({ title: `Step ${i}`, body: "a".repeat(60_000) });
    const many = Array.from({ length: 17 }, (_, i) => sub(i));
    expect(await code(() => createTask(ctx, { title: "Big", subtasks: many }))).toBe("VALIDATION");
    expect(await code(() => createTask(ctx, { title: "Ok", subtasks: many.slice(0, 16) }))).toBe(
      "ok",
    );
  });

  // Records written under the older character cap must still import and stay editable.
  it("imports and edits a stored body over 100 KB, but new text is capped", async () => {
    const { ctx } = await setup();
    const other = await setup();
    const old = await createNote(other.ctx, { title: "Old" });
    const record = { ...old, projectId: ctx.projectId, body: "ក".repeat(40_000) };
    await importRecords(ctx, [{ entity: "note", source: `notes/${old.id}.json`, record }]);
    const renamed = await updateNote(ctx, old.id, { title: "Renamed" });
    expect(renamed.body).toBe(record.body);
    expect(await code(() => updateNote(ctx, old.id, { body: `${record.body}!` }))).toBe(
      "VALIDATION",
    );
  });

  it("reports doctor checks and blocks review mistakes", async () => {
    const { ctx, clock } = await setup();
    const clean = await doctorChecks(ctx);
    expect(clean.every((check) => check.ok)).toBe(true);
    const task = await createTask(ctx, { title: "Claim me" });
    const claimed = await claimTask(ctx, task.id, { leaseMinutes: 1 });
    const token = claimed.claim?.token;
    await acquireLock(ctx, { paths: ["src/**"], leaseMinutes: 1 });
    clock.advance(2 * 60 * 1000);
    const stale = await doctorChecks(ctx);
    expect(stale.find((check) => check.name === "claims")?.ok).toBe(false);
    expect(stale.find((check) => check.name === "locks")?.ok).toBe(false);
    const done = await completeTask(ctx, task.id, {
      summary: "shipped",
      filesTouched: ["a.ts"],
      token,
    });
    expect(done.status).toBe("review");
    expect(
      await code(() => completeTask(ctx, task.id, { summary: "again", filesTouched: ["a.ts"] })),
    ).toBe("INVALID_TRANSITION");
    expect(await code(() => updateTask(ctx, task.id, { status: "done" }))).toBe(
      "INVALID_TRANSITION",
    );
    expect(await code(() => updateTask(ctx, task.id, { status: "todo" }))).toBe("VALIDATION");
    const human = await ensureActor(ctx, { name: "ada@test", kind: "human" });
    const brief = await buildBrief({ ...ctx, actorId: human.id });
    expect(brief.markdown).toContain("Waiting for review");
  });

  it("checks feature removal, notes and settings", async () => {
    const { ctx } = await setup();
    const milestone = await createMilestone(ctx, { title: "M" });
    expect(
      await code(() =>
        createFeature(ctx, { title: "F", milestoneId: "mil_01M6GMFKG0QFF1E44RZG05GC7W" }),
      ),
    ).toBe("NOT_FOUND");
    const feature = await createFeature(ctx, { title: "F", milestoneId: milestone.id });
    await updateFeature(ctx, feature.id, { status: "building" });
    await updateFeature(ctx, feature.id, { status: "shipped" });
    expect(await code(() => updateFeature(ctx, feature.id, { status: "removed" }))).toBe(
      "VALIDATION",
    );
    const other = await recordDecision(ctx, {
      title: "Why",
      context: "c",
      decision: "d",
      consequences: "k",
      featureIds: [],
    });
    expect(
      await code(() => updateFeature(ctx, feature.id, { status: "removed", decisionId: other.id })),
    ).toBe("VALIDATION");
    const note = await createNote(ctx, { title: "N", body: "b" });
    await updateNote(ctx, note.id, { reviewed: true, expectedVersion: note.version });
    await updateFeature(ctx, feature.id, { reviewed: true });
    const empty = new MemoryStore();
    expect(await code(() => getProject(empty))).toBe("NOT_INITIALIZED");
    expect(await code(() => updateSettings({ ...ctx, projectId: "prj_other" }, {}))).toBe(
      "NOT_INITIALIZED",
    );
    expect(
      await code(() =>
        createTask(ctx, { title: "Parent", subtasks: [{ title: "A", dependsOn: [3] }] }),
      ),
    ).toBe("VALIDATION");
  });
});

// A store that ignores the paging cursor (a `sati serve` daemon from an older version) used to
// make every full read loop forever once an entity held 500 records.
describe("listAll", () => {
  it("fails instead of looping when the store does not move past the cursor", async () => {
    const { ctx } = await setup();
    const page = Array.from({ length: 500 }, (_, i) => ({ id: `tsk_${i}` }));
    const stuck = { list: async () => page } as unknown as Parameters<typeof listAll>[0];
    await expect(listAll(stuck, ctx, "task")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
