import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      newer: [],
    });
    expect(existsSync(join(dir, `tasks/${t1.id}.json`))).toBe(true);
    expect(readFileSync(join(dir, "tasks/tsk_teammate.json"), "utf8")).toBe("{}\n");
    // Atomic writes leave no temp files behind.
    expect(readdirSync(join(dir, "tasks")).filter((f) => !f.endsWith(".json"))).toEqual([]);
  });

  // A file ahead of the database is a teammate's edit that is not imported yet (the import did
  // not run, or was refused). Exporting over it would commit the older copy and lose their edit.
  it("leaves a file alone when it holds a newer version than the database", async () => {
    const a = await clone();
    const dir = tempDir();
    const t = await createTask(a, { title: "Mine" });
    await exportSnapshot(a, dir);
    const file = join(dir, `tasks/${t.id}.json`);
    const theirs = readFileSync(file, "utf8")
      .replace('"Mine"', '"Theirs"')
      .replace('"version": 1', '"version": 2');
    writeFileSync(file, theirs);
    expect(await exportSnapshot(a, dir)).toEqual({
      written: [],
      unchanged: 0,
      newer: [`tasks/${t.id}.json`],
    });
    expect(readFileSync(file, "utf8")).toBe(theirs);
  });

  // After a write, only that write's records are exported; other changes wait for a full export.
  it("exports only the given records when asked", async () => {
    const a = await clone();
    const dir = tempDir();
    const t1 = await createTask(a, { title: "One" });
    const t2 = await createTask(a, { title: "Two" });
    const out = await exportSnapshot(a, dir, {
      only: [
        { entity: "task", id: t2.id },
        { entity: "task", id: t2.id },
        { entity: "actor", id: a.actorId },
      ],
    });
    expect(out).toEqual({ written: [`tasks/${t2.id}.json`], unchanged: 0, newer: [] });
    expect(existsSync(join(dir, `tasks/${t1.id}.json`))).toBe(false);
    expect((await exportSnapshot(a, dir)).written).toEqual([`tasks/${t1.id}.json`]);

    // A private note never reaches .sati/, whether a full or an incremental export runs.
    const secret = await createNote(a, { title: "Salary bands", body: "x", private: true });
    expect(await exportSnapshot(a, dir, { only: [{ entity: "note", id: secret.id }] })).toEqual({
      written: [],
      unchanged: 0,
      newer: [],
    });
    expect(existsSync(join(dir, `notes/${secret.id}.json`))).toBe(false);
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

  // WHY: .sati/ is committed by teammates; a symlink there must not pull in files outside the repo
  // or echo their content in an error.
  it("refuses symlinked record files and does not quote file content in parse errors", () => {
    const dir = tempDir();
    const outside = tempDir();
    mkdirSync(join(dir, "tasks"));
    writeFileSync(join(outside, "secret.json"), '{ "id": "tsk_x" }\n');
    symlinkSync(join(outside, "secret.json"), join(dir, "tasks/tsk_x.json"));
    expect(() => readSnapshot(dir)).toThrow(/not a regular file/);

    rmSync(join(dir, "tasks/tsk_x.json"));
    writeFileSync(join(dir, "tasks/tsk_y.json"), "{ hunter2-password");
    let message = "";
    try {
      readSnapshot(dir);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("not valid JSON");
    expect(message).not.toContain("hunter2");
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

  // After-write exports write only these records, so a rolled-back write must not appear, and
  // a failed export must not lose the records it was given.
  it("passes the records of committed writes, again after a failed run", async () => {
    const a = await clone();
    const runs: string[][] = [];
    let fail = true;
    const synced = afterWrites(
      a.store,
      2 ** 31 - 1,
      async (written) => {
        // Writes also touch the actor (last seen); actors are not in the snapshot.
        const keys = written.filter((w) => w.entity !== "actor").map((w) => `${w.entity}:${w.id}`);
        runs.push(keys.sort());
        if (fail) throw new Error("disk full");
      },
      () => {},
    );
    const ctx = { ...a, store: synced.store };
    const t1 = await createTask(ctx, { title: "one" });
    await synced.store
      .write(async (w) => {
        await w.insert("task", { ...t1, id: "tsk_rolled_back" });
        throw new Error("rollback");
      })
      .catch(() => undefined);
    await synced.flush();
    fail = false;
    const t2 = await updateTask(ctx, t1.id, { title: "one, renamed", expectedVersion: 1 });
    const n = await createNote(ctx, { title: "n" });
    await synced.flush();
    expect(runs).toEqual([[`task:${t1.id}`], [`note:${n.id}`, `task:${t2.id}`].sort()]);
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

  // Shutdown must not drop what a failed export put back, nor race one still running.
  it("flush retries records a failed export kept, and waits for a running export", async () => {
    vi.useFakeTimers();
    const a = await clone();
    const runs: string[][] = [];
    let fail = true;
    let release: () => void = () => {};
    const synced = afterWrites(
      a.store,
      10,
      async (written) => {
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
        await new Promise<void>((r) => {
          release = r;
        });
        runs.push(written.map((w) => w.id));
      },
      () => {},
    );
    const t = await createTask({ ...a, store: synced.store }, { title: "x" });
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toEqual([]);
    let flushed = false;
    const done = synced.flush().then(() => {
      flushed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    release();
    await done;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(t.id);
  });
});
