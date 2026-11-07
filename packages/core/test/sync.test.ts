import { describe, expect, it } from "vitest";
import {
  claimTask,
  createNote,
  createTask,
  ensureActor,
  importRecords,
  snapshotRecords,
} from "../src/index.js";
import { setup } from "./support/setup.js";

const LATER = "2026-11-04T09:00:00.000Z";

describe("snapshotRecords", () => {
  // PLAN: soft-deleted records keep a tombstone so the deletion merges correctly.
  it("includes soft-deleted records, and leaves out actors", async () => {
    const { ctx } = await setup();
    const task = await createTask(ctx, { title: "Live" });
    const note = await createNote(ctx, { title: "Gone" });
    await importRecords(ctx, [
      {
        entity: "note",
        source: "notes/x.json",
        record: { ...note, version: 2, deletedAt: LATER, updatedAt: LATER },
      },
    ]);
    const records = await snapshotRecords(ctx);
    expect(records.map((r) => r.record.id).sort()).toEqual([note.id, task.id].sort());
    expect(records.find((r) => r.entity === "note")?.record.deletedAt).toBe(LATER);
  });
});

describe("importRecords", () => {
  it("inserts unknown records and logs each import", async () => {
    const { ctx, store } = await setup();
    const other = await setup();
    const task = await createTask(other.ctx, { title: "From a teammate" });
    const before = store.activity.length;
    const r = await importRecords(ctx, [
      { entity: "task", source: "tasks/a.json", record: { ...task, projectId: ctx.projectId } },
    ]);
    expect(r).toEqual({ imported: [{ entity: "task", id: task.id, version: 1 }], unchanged: 0 });
    expect(store.activity.slice(before)).toEqual([
      expect.objectContaining({
        verb: "import",
        entity: "task",
        entityId: task.id,
        actorId: ctx.actorId,
        diff: { version: 1, from: null },
      }),
    ]);
  });

  // PLAN: import upserts records whose version or updatedAt is newer. A stale snapshot file
  // must never roll back a newer DB record.
  it("replaces a record only with a higher version, or the same version edited later", async () => {
    const { ctx, store } = await setup();
    const task = await createTask(ctx, { title: "v1" });
    const imp = (record: object) =>
      importRecords(ctx, [
        { entity: "task", source: "tasks/t.json", record: { ...task, ...record } },
      ]);

    expect((await imp({ title: "same" })).unchanged).toBe(1);
    expect((await imp({ title: "v2", version: 2 })).imported).toHaveLength(1);
    expect((await imp({ title: "old", version: 1, updatedAt: LATER })).unchanged).toBe(1);
    expect((await imp({ title: "v2 later", version: 2, updatedAt: LATER })).imported).toHaveLength(
      1,
    );
    expect(await store.read((r) => r.get("task", task.id))).toMatchObject({
      title: "v2 later",
      version: 2,
    });
  });

  // One bad file must not leave the DB half-imported.
  it("rejects the whole import when any record is invalid or from another project", async () => {
    const { ctx, store } = await setup();
    const other = await setup();
    const good = await createTask(other.ctx, { title: "ok" });
    const mine = { ...good, projectId: ctx.projectId };
    const before = store.activity.length;
    await expect(
      importRecords(ctx, [
        { entity: "task", source: "tasks/good.json", record: mine },
        { entity: "task", source: "tasks/bad.json", record: { ...mine, sneaky: true } },
      ]),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("tasks/bad.json"),
    });
    await expect(
      importRecords(ctx, [{ entity: "task", source: "tasks/foreign.json", record: good }]),
    ).rejects.toMatchObject({ message: expect.stringContaining("belongs to project") });
    expect(await store.read((r) => r.get("task", good.id))).toBeUndefined();
    expect(store.activity.length).toBe(before);
  });
});

describe("timestamps", () => {
  // PLAN Phase 5b: leases compare as strings, and "…:00Z" sorts after "…:00.500Z". An imported
  // lease without milliseconds looked live after it had run out, so nobody could claim the task.
  it("stores imported timestamps with milliseconds, so an expired lease reads as expired", async () => {
    const { ctx, clock } = await setup();
    const other = await ensureActor(ctx, { name: "codex@b", kind: "agent", tool: "codex" });
    const task = await createTask(ctx, { title: "Imported" });
    const claim = {
      actorId: other.id,
      leaseUntil: "2026-11-03T12:00:00Z",
      heartbeatAt: "2026-11-03T11:30:00Z",
      token: 2,
    };
    const record = { ...task, status: "in_progress", claim, version: 2, updatedAt: LATER };
    await importRecords(ctx, [{ entity: "task", source: "tasks/a.json", record }]);
    const stored = (await snapshotRecords(ctx)).find((r) => r.record.id === task.id)?.record;
    expect(stored).toMatchObject({ claim: { leaseUntil: "2026-11-03T12:00:00.000Z" } });
    clock.advance(500);
    expect((await claimTask(ctx, task.id)).claim?.actorId).toBe(ctx.actorId);
  });
});
