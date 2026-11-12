import { describe, expect, it } from "vitest";
import type { Actor, Lock, Milestone, Project, StorageAdapter, Task } from "../../src/index.js";

/**
 * What every StorageAdapter must do, run against the in-memory test store and SqliteStore.
 * Core tests run on the memory store; if it differs from the real one, they can pass on
 * behaviour users never get (review WP7). Only types come from core, so `store-sqlite` can run
 * this file against its own build of core without a second copy of the classes.
 */
export function storeContract(name: string, open: () => Promise<StorageAdapter>): void {
  const NOW = "2026-11-03T12:00:00.000Z";
  const ACTOR = "actr_01JC0000000000000000000000";
  const PROJECT = "prj_01JC0000000000000000000000";
  let seq = 0;
  // Ids sort in creation order, as ULIDs do.
  const id = (prefix: string) => `${prefix}_01JD${String(++seq).padStart(22, "0")}`;
  const base = () => ({
    projectId: PROJECT,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: ACTOR,
    version: 1,
    deletedAt: null,
  });
  const project = (over: Partial<Project> = {}): Project => ({
    id: PROJECT,
    slug: "demo",
    name: "Demo",
    repoUrl: null,
    mode: "git",
    settings: { leaseMinutes: 30, review: "agents", autoContinue: false },
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: ACTOR,
    version: 1,
    deletedAt: null,
    ...over,
  });
  const task = (over: Partial<Task> = {}): Task => ({
    id: id("tsk"),
    ...base(),
    title: "Task",
    body: "",
    status: "todo",
    priority: "medium",
    featureId: null,
    parentId: null,
    dependsOn: [],
    labels: [],
    branch: null,
    worktree: null,
    claim: null,
    completion: null,
    ...over,
  });
  const milestone = (order: number): Milestone => ({
    id: id("mil"),
    ...base(),
    title: `M${order}`,
    goal: "",
    targetDate: null,
    status: "planned",
    order,
  });
  const actor = (actorName: string, over: Partial<Actor> = {}): Actor => ({
    id: id("actr"),
    projectId: PROJECT,
    kind: "agent",
    name: actorName,
    tool: null,
    worktree: null,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    deletedAt: null,
    ...over,
  });
  const errorCode = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return "ok";
    } catch (err) {
      return (err as { code?: string }).code ?? "no code";
    }
  };

  /** A fresh store holding the project and `records`, inserted in one write. */
  async function seeded(...records: (Task | Milestone | Actor)[]): Promise<StorageAdapter> {
    const store = await open();
    await store.write(async (w) => {
      await w.insert("project", project());
      for (const r of records) {
        if ("priority" in r) await w.insert("task", r);
        else if ("order" in r) await w.insert("milestone", r);
        else await w.insert("actor", r);
      }
    });
    return store;
  }

  describe(`${name}: store contract`, () => {
    // Tasks list by priority first: `next`, the board and the brief all rely on that order.
    it("lists tasks by priority, then id, and reverses both with newestFirst", async () => {
      const low = task({ priority: "low" });
      const urgent = task({ priority: "urgent" });
      const mediumA = task();
      const mediumB = task();
      const store = await seeded(low, urgent, mediumA, mediumB);
      const ids = (q: Parameters<typeof list>[0] = {}) => list(q).then((ts) => ts.map((t) => t.id));
      const list = (q: { newestFirst?: boolean }) => store.read((r) => r.list("task", PROJECT, q));
      expect(await ids()).toEqual([urgent.id, mediumA.id, mediumB.id, low.id]);
      expect(await ids({ newestFirst: true })).toEqual([low.id, mediumB.id, mediumA.id, urgent.id]);
      await store.close();
    });

    it("lists milestones by their order", async () => {
      const second = milestone(2);
      const first = milestone(1);
      const store = await seeded(second, first);
      const rows = await store.read((r) => r.list("milestone", PROJECT));
      expect(rows.map((m) => m.id)).toEqual([first.id, second.id]);
      await store.close();
    });

    it("filters by parent", async () => {
      const parent = task();
      const child = task({ parentId: parent.id });
      const store = await seeded(parent, child, task());
      const rows = await store.read((r) => r.list("task", PROJECT, { parentId: parent.id }));
      expect(rows.map((t) => t.id)).toEqual([child.id]);
      await store.close();
    });

    // A caller asking for 10,000 rows must not load them all: the store caps every page.
    it("returns 50 rows by default and at most 500", async () => {
      const store = await seeded(...Array.from({ length: 520 }, () => task()));
      const count = (limit?: number) =>
        store.read((r) => r.list("task", PROJECT, limit === undefined ? {} : { limit }));
      expect((await count()).length).toBe(50);
      expect((await count(10_000)).length).toBe(500);
      await store.close();
    });

    it("continues after a cursor in list order, and refuses an unknown cursor", async () => {
      const high = task({ priority: "high" });
      const a = task();
      const b = task();
      const gone = task({ deletedAt: NOW });
      const store = await seeded(high, a, b, gone);
      const after = (cursor: string, newestFirst = false) =>
        store
          .read((r) => r.list("task", PROJECT, { after: cursor, newestFirst }))
          .then((ts) => ts.map((t) => t.id));
      expect(await after(high.id)).toEqual([a.id, b.id]);
      expect(await after(b.id, true)).toEqual([a.id, high.id]);
      // The cursor row may be filtered out of the page (here: deleted) and still mark the place.
      expect(await after(gone.id)).toEqual([]);
      // An unknown cursor is an error, never silently the first page again.
      expect(await errorCode(() => after("tsk_01JDUNKNOWNUNKNOWNUNKNOWNUN"))).toBe("NOT_FOUND");
      await store.close();
    });

    it("lists ready tasks by priority, then id", async () => {
      const medium = task();
      const urgent = task({ priority: "urgent" });
      const store = await seeded(medium, urgent);
      const ready = await store.read((r) => r.readyTasks(PROJECT, NOW, 10));
      expect(ready.map((t) => t.id)).toEqual([urgent.id, medium.id]);
      await store.close();
    });

    // listTasks pages the ready queue to find filtered matches past the 500 cap (review WP2.3).
    it("continues the ready queue after a cursor, and refuses an unknown cursor", async () => {
      const urgent = task({ priority: "urgent" });
      const a = task();
      const b = task();
      const store = await seeded(urgent, a, b);
      const after = (cursor: string) =>
        store.read((r) => r.readyTasks(PROJECT, NOW, 10, cursor)).then((ts) => ts.map((t) => t.id));
      expect(await after(urgent.id)).toEqual([a.id, b.id]);
      expect(await after(b.id)).toEqual([]);
      expect(await errorCode(() => after("tsk_01JDUNKNOWNUNKNOWNUNKNOWNUN"))).toBe("NOT_FOUND");
      await store.close();
    });

    // Plan import looks up only the tasks it may already have made (review WP3.2).
    it("filters by any of several labels", async () => {
      const a = task({ labels: ["plan:a", "x"] });
      const b = task({ labels: ["plan:b"], deletedAt: NOW });
      const store = await seeded(a, b, task({ labels: ["plan:c"] }), task());
      const ids = (anyLabel: string[], includeDeleted = false) =>
        store
          .read((r) => r.list("task", PROJECT, { anyLabel, includeDeleted }))
          .then((ts) => ts.map((t) => t.id));
      expect(await ids(["plan:a", "plan:b"])).toEqual([a.id]);
      expect(await ids(["plan:a", "plan:b"], true)).toEqual([a.id, b.id]);
      expect(await ids([])).toEqual([]);
      await store.close();
    });

    // Lock checks find a task's locks by index instead of reading every lock (review WP3.1).
    it("filters locks by task, skipping released ones", async () => {
      const lock = (taskId: string | null, over: Partial<Lock> = {}): Lock => ({
        id: id("lock"),
        ...base(),
        paths: ["src"],
        actorId: ACTOR,
        taskId,
        reason: "",
        leaseUntil: NOW,
        mode: "exclusive",
        ...over,
      });
      const mine = task();
      const held = lock(mine.id);
      const released = lock(mine.id, { deletedAt: NOW });
      const other = lock(task().id);
      const store = await seeded(mine);
      await store.write(async (w) => {
        for (const l of [held, released, other, lock(null)]) await w.insert("lock", l);
      });
      const rows = await store.read((r) => r.list("lock", PROJECT, { taskId: mine.id }));
      expect(rows.map((l) => l.id)).toEqual([held.id]);
      await store.close();
    });

    // A deleted actor keeps its name, so a new actor cannot take it and inherit its history.
    it("finds an actor by name, deleted or not, and keeps names unique", async () => {
      const old = actor("claude-code@main", { deletedAt: NOW });
      const store = await seeded(old);
      const found = await store.read((r) => r.getByKey("actor", PROJECT, "claude-code@main"));
      expect(found?.id).toBe(old.id);
      const twin = actor("claude-code@main");
      expect(await errorCode(() => store.write((w) => w.insert("actor", twin)))).toBe("CONFLICT");
      const other = actor("codex@main");
      await store.write((w) => w.insert("actor", other));
      const renamed = { ...other, name: "claude-code@main", version: 2 };
      expect(await errorCode(() => store.write((w) => w.update("actor", renamed, 1)))).toBe(
        "CONFLICT",
      );
      await store.close();
    });

    it("finds the project by slug, and hides a deleted project from getProject", async () => {
      const store = await seeded();
      expect((await store.read((r) => r.getByKey("project", PROJECT, "demo")))?.id).toBe(PROJECT);
      await store.write((w) => w.update("project", project({ deletedAt: NOW, version: 2 }), 1));
      expect(await store.read((r) => r.getProject())).toBeUndefined();
      await store.close();
    });

    // The brief finds your last session across every session actor in one query.
    it("filters activity by any of several actors", async () => {
      const store = await seeded();
      const row = (actorId: string, at: string) => ({
        id: id("act"),
        projectId: PROJECT,
        actorId,
        verb: "update" as const,
        entity: "task" as const,
        entityId: "tsk_01JD0000000000000000000000",
        diff: {},
        branch: null,
        at,
      });
      const [a, b, c] = ["actr_01JDA", "actr_01JDB", "actr_01JDC"];
      await store.write(async (w) => {
        await w.appendActivity(row(a, "2026-11-03T12:00:01.000Z"));
        await w.appendActivity(row(b, "2026-11-03T12:00:02.000Z"));
        await w.appendActivity(row(c, "2026-11-03T12:00:03.000Z"));
      });
      const actors = (actorIds: string[]) =>
        store
          .read((r) => r.listActivity(PROJECT, { actorIds }))
          .then((rs) => rs.map((x) => x.actorId));
      expect(await actors([a, b])).toEqual([b, a]);
      expect(await actors([])).toEqual([]);
      await store.close();
    });

    // `undo` takes the short handle that `activity` prints; another project's row must not match.
    it("finds this project's activity by id suffix, in any case", async () => {
      const store = await seeded();
      const row = (rowId: string, projectId: string) => ({
        id: rowId,
        projectId,
        actorId: ACTOR,
        verb: "update" as const,
        entity: "task" as const,
        entityId: "tsk_01JD0000000000000000000000",
        diff: {},
        branch: null,
        at: NOW,
      });
      await store.write(async (w) => {
        await w.appendActivity(row("act_01JD000000000000000000ABCDEF", PROJECT));
        await w.appendActivity(row("act_01JD000000000000000001ABCDEF", "prj_01JDOTHER"));
        await w.appendActivity(row("act_01JD000000000000000000ZZZZZZ", PROJECT));
      });
      const ids = (suffix: string) =>
        store
          .read((r) => r.findActivityBySuffix(PROJECT, suffix))
          .then((rs) => rs.map((a) => a.id));
      expect(await ids("abcdef")).toEqual(["act_01JD000000000000000000ABCDEF"]);
      expect(await ids("NOPE")).toEqual([]);
      await store.close();
    });

    it("lists activity newest first, and caps a page at 500", async () => {
      const store = await seeded();
      await store.write(async (w) => {
        for (let i = 0; i < 510; i++) {
          // `at` goes back in time while rows are appended: order follows `at`, not insertion.
          const at = new Date(Date.parse(NOW) - i * 1000).toISOString();
          await w.appendActivity({
            id: id("act"),
            projectId: PROJECT,
            actorId: ACTOR,
            verb: "update",
            entity: "task",
            entityId: "tsk_01JD0000000000000000000000",
            diff: {},
            branch: null,
            at,
          });
        }
      });
      const rows = await store.read((r) => r.listActivity(PROJECT, { limit: 10_000 }));
      expect(rows.length).toBe(500);
      expect(rows[0]?.at).toBe(NOW);
      expect(rows.every((a, i) => i === 0 || a.at <= (rows[i - 1]?.at ?? ""))).toBe(true);
      await store.close();
    });
  });
}
