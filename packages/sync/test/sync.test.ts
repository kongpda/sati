import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdFactory,
  createNote,
  createTask,
  fixedClock,
  importRecords,
  initProject,
  listTasks,
  type ServiceContext,
  updateTask,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  afterWrites,
  encodeRecord,
  exportSnapshot,
  importSnapshot,
  readSnapshot,
  stableJson,
} from "../src/index.js";

const dirs: string[] = [];
const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sati-sync-"));
  dirs.push(d);
  return d;
}

/** One clone's DB. Clones of one repo share the project id from the committed config. */
async function clone(projectId?: string): Promise<ServiceContext> {
  const store = await SqliteStore.open(join(tempDir(), "sati.db"));
  stores.push(store);
  const clock = fixedClock("2026-11-03T12:00:00.000Z");
  const base = createIdFactory();
  const ids: typeof base = (e) => (e === "project" && projectId ? projectId : base(e));
  const { project, actor } = await initProject(
    { store, clock, ids },
    { slug: "demo", name: "Demo" },
    { name: "agent@test", kind: "agent" },
  );
  return { store, clock, ids, projectId: project.id, actorId: actor.id, branch: "main" };
}

describe("stableJson", () => {
  // PLAN: sorted keys and stable formatting keep git diffs to the fields that changed.
  it("sorts keys at every depth, indents 2 spaces and ends with a newline", () => {
    expect(stableJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});

describe("exportSnapshot / importSnapshot", () => {
  it("carries records and tombstones from one clone to another", async () => {
    const a = await clone();
    const b = await clone(a.projectId);
    const dir = tempDir();
    const task = await createTask(a, { title: "Ship it" });
    const note = await createNote(a, { title: "Gone" });
    // There is no delete service yet; an import is the only way to write a tombstone.
    const deletedAt = "2026-11-03T13:00:00.000Z";
    await importRecords(a, [
      {
        entity: "note",
        source: "x",
        record: { ...note, version: 2, deletedAt, updatedAt: deletedAt },
      },
    ]);

    const out = await exportSnapshot(a, dir);
    expect(out.written.sort()).toEqual([`notes/${note.id}.json`, `tasks/${task.id}.json`].sort());
    expect(readFileSync(join(dir, `tasks/${task.id}.json`), "utf8")).toBe(
      stableJson(encodeRecord(task)),
    );

    const r = await importSnapshot(b, dir);
    expect(r.imported).toHaveLength(2);
    expect(await b.store.read((s) => s.get("task", task.id))).toEqual(task);
    expect(await b.store.read((s) => s.get("note", note.id))).toMatchObject({ deletedAt });
  });

  // PLAN: only changed records are rewritten, so a commit touches only what changed.
  it("rewrites only the files whose record changed, and leaves unknown files alone", async () => {
    const a = await clone();
    const dir = tempDir();
    const t1 = await createTask(a, { title: "One" });
    const t2 = await createTask(a, { title: "Two" });
    await exportSnapshot(a, dir);
    writeFileSync(join(dir, "tasks/tsk_teammate.json"), "{}\n");

    await updateTask(a, t2.id, { title: "Two, renamed", expectedVersion: 1 });
    expect(await exportSnapshot(a, dir)).toEqual({
      written: [`tasks/${t2.id}.json`],
      unchanged: 1,
    });
    expect(existsSync(join(dir, `tasks/${t1.id}.json`))).toBe(true);
    expect(readFileSync(join(dir, "tasks/tsk_teammate.json"), "utf8")).toBe("{}\n");
    // Atomic writes leave no temp files behind.
    expect(readdirSync(join(dir, "tasks")).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });

  // A broken file must not half-import: nothing is written and the file is named.
  it("rejects the whole import when one file is broken", async () => {
    const a = await clone();
    const dir = tempDir();
    await createTask(a, { title: "Fine" });
    await exportSnapshot(a, dir);
    const b = await clone(a.projectId);

    writeFileSync(join(dir, "tasks/tsk_bad.json"), "{ nope");
    await expect(importSnapshot(b, dir)).rejects.toMatchObject({
      code: "VALIDATION",
      // Reported paths use `/` on every OS.
      message: expect.stringContaining("tasks/tsk_bad.json"),
    });
    expect(await listTasks(b)).toEqual([]);

    writeFileSync(join(dir, "tasks/tsk_bad.json"), '{ "id": "tsk_other" }\n');
    expect(() => readSnapshot(dir)).toThrow(/does not match the record id/);
  });

  it("reads an empty snapshot folder as no records", () => {
    expect(readSnapshot(tempDir())).toEqual([]);
  });
});

describe("afterWrites", () => {
  // PLAN: export is debounced 2 s after the last write.
  it("runs once, after the last write of a burst, and flush runs a pending export", async () => {
    vi.useFakeTimers();
    const a = await clone();
    const fn = vi.fn(async () => {});
    const synced = afterWrites(a.store, 2000, fn, () => {});
    const ctx = { ...a, store: synced.store };
    await createTask(ctx, { title: "1" });
    await vi.advanceTimersByTimeAsync(1500);
    await createTask(ctx, { title: "2" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);

    await createTask(ctx, { title: "3" });
    await synced.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    await synced.flush();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("reports export errors without failing the write", async () => {
    vi.useFakeTimers();
    const a = await clone();
    const onError = vi.fn();
    const synced = afterWrites(
      a.store,
      10,
      async () => Promise.reject(new Error("disk full")),
      onError,
    );
    await createTask({ ...a, store: synced.store }, { title: "x" });
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(new Error("disk full"));
  });
});
