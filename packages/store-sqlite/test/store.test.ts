import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { BrainError } from "@brain/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.gen.js";
import { NOW, note, PROJECT_ID, project, task, tmpDb } from "./fixtures.js";

let path: string;
let store: SqliteStore;

beforeEach(async () => {
  path = tmpDb();
  store = await SqliteStore.open(path);
  await store.write((w) => w.insert("project", project()));
});
afterEach(async () => {
  await store.close();
});

describe("open", () => {
  it("migrates a new DB to the latest schema with WAL on", () => {
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("busy_timeout", { simple: true })).toBe(5000);
  });

  // Upgrades must be reversible: a failed or bad migration should never lose the user's data.
  it("backs up an existing DB before migrating it", async () => {
    const v1 = tmpDb();
    const raw = new Database(v1);
    raw.exec(MIGRATIONS[0]?.sql ?? "");
    raw.pragma("user_version = 1");
    raw.close();
    const upgraded = await SqliteStore.open(v1);
    expect(upgraded.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    await upgraded.close();
    const backups = readdirSync(join(dirname(v1), "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^brain\.db\.v1\..+\.bak$/);
  });

  it("does not back up a brand-new DB", () => {
    expect(existsSync(join(dirname(path), "backups"))).toBe(false);
  });

  // An old MCP server still running after an upgrade must not write with the old schema.
  it("refuses writes when a newer binary has upgraded the schema", async () => {
    store.db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    const err = await store.write((w) => w.insert("task", task())).catch((e) => e);
    expect(err).toBeInstanceOf(BrainError);
    expect(err.code).toBe("SCHEMA_TOO_NEW");
    expect(await store.read((r) => r.list("task", PROJECT_ID))).toHaveLength(0);
  });
});

describe("writes", () => {
  it("round-trips a record", async () => {
    const t = task({ labels: ["a"] });
    await store.write((w) => w.insert("task", t));
    expect(await store.read((r) => r.get("task", t.id))).toEqual(t);
    expect(await store.read((r) => r.getProject())).toEqual(project());
  });

  it("rolls back the whole transaction when the callback throws", async () => {
    const t = task();
    await expect(
      store.write(async (w) => {
        await w.insert("task", t);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.read((r) => r.get("task", t.id))).toBeUndefined();
  });

  // Optimistic concurrency: a stale writer must not silently overwrite a newer version.
  it("rejects an update with a stale version", async () => {
    const t = task();
    await store.write((w) => w.insert("task", t));
    await store.write((w) => w.update("task", { ...t, title: "v2", version: 2 }, 1));
    const err = await store
      .write((w) => w.update("task", { ...t, title: "stale", version: 2 }, 1))
      .catch((e) => e);
    expect(err.code).toBe("CONFLICT");
    expect((await store.read((r) => r.get("task", t.id)))?.title).toBe("v2");
  });

  it("rejects a duplicate insert as a conflict", async () => {
    const t = task();
    await store.write((w) => w.insert("task", t));
    await expect(store.write((w) => w.insert("task", t))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("serialises concurrent writes from the same process", async () => {
    const ts = Array.from({ length: 20 }, () => task());
    await Promise.all(ts.map((t) => store.write((w) => w.insert("task", t))));
    expect(await store.read((r) => r.list("task", PROJECT_ID, { limit: 100 }))).toHaveLength(20);
  });
});

describe("queries", () => {
  it("filters by status, label and deleted, ordered by priority", async () => {
    const low = task({ priority: "low" });
    const urgent = task({ priority: "urgent", labels: ["ui"] });
    const gone = task({ deletedAt: NOW });
    const back = task({ status: "backlog" });
    await store.write(async (w) => {
      for (const t of [low, urgent, gone, back]) await w.insert("task", t);
    });
    const todo = await store.read((r) => r.list("task", PROJECT_ID, { status: ["todo"] }));
    expect(todo.map((t) => t.id)).toEqual([urgent.id, low.id]);
    const ui = await store.read((r) => r.list("task", PROJECT_ID, { label: "ui" }));
    expect(ui.map((t) => t.id)).toEqual([urgent.id]);
    const all = await store.read((r) => r.list("task", PROJECT_ID, { includeDeleted: true }));
    expect(all).toHaveLength(4);
  });

  it("finds records by short-handle suffix", async () => {
    const t = task();
    await store.write((w) => w.insert("task", t));
    const hits = await store.read((r) => r.findBySuffix("task", t.id.slice(-6).toLowerCase()));
    expect(hits.map((h) => h.id)).toEqual([t.id]);
    expect(await store.read((r) => r.findBySuffix("task", "%"))).toHaveLength(1);
  });

  it("returns ready tasks: todo, deps done, claim expired or absent", async () => {
    const dep = task({ status: "in_progress" });
    const blockedByDep = task({ dependsOn: [dep.id] });
    const free = task();
    const claimed = task({
      claim: {
        actorId: "actr_01JC0000000000000000000009",
        leaseUntil: "2026-11-03T13:00:00.000Z",
        heartbeatAt: NOW,
      },
    });
    const expired = task({
      claim: {
        actorId: "actr_01JC0000000000000000000009",
        leaseUntil: "2026-11-03T11:00:00.000Z",
        heartbeatAt: NOW,
      },
    });
    await store.write(async (w) => {
      for (const t of [dep, blockedByDep, free, claimed, expired]) await w.insert("task", t);
    });
    const ready = await store.read((r) => r.readyTasks(PROJECT_ID, NOW, 10));
    expect(ready.map((t) => t.id).sort()).toEqual([free.id, expired.id].sort());

    await store.write((w) => w.update("task", { ...dep, status: "review", version: 2 }, 1));
    const stillBlocked = await store.read((r) => r.readyTasks(PROJECT_ID, NOW, 10));
    expect(stillBlocked.map((t) => t.id)).not.toContain(blockedByDep.id);
  });
});

describe("search", () => {
  it("finds tasks and notes by words and prefixes, ranked", async () => {
    await store.write(async (w) => {
      await w.insert("task", task({ title: "Merge driver for JSON", body: "three-way merge" }));
      await w.insert("note", note({ title: "Research", body: "notes on merging strategies" }));
      await w.insert("task", task({ title: "Unrelated" }));
    });
    const hits = await store.read((r) => r.search(PROJECT_ID, "merg"));
    expect(hits).toHaveLength(2);
    expect(hits[0]?.title).toBe("Merge driver for JSON");
    const onlyNotes = await store.read((r) => r.search(PROJECT_ID, "merg", { entities: ["note"] }));
    expect(onlyNotes.map((h) => h.entity)).toEqual(["note"]);
  });

  it("drops soft-deleted records from the index", async () => {
    const t = task({ title: "Ephemeral" });
    await store.write((w) => w.insert("task", t));
    await store.write((w) => w.update("task", { ...t, deletedAt: NOW, version: 2 }, 1));
    expect(await store.read((r) => r.search(PROJECT_ID, "ephemeral"))).toEqual([]);
  });

  // User text must never be interpreted as FTS syntax (column filters, NEAR, unbalanced quotes).
  it("treats operators and quotes in the query as plain text", async () => {
    await store.write((w) => w.insert("task", task({ title: "Alpha OR beta" })));
    for (const q of ['"', "title:alpha", "NEAR(alpha", "alpha*)", "-", "*"]) {
      await expect(store.read((r) => r.search(PROJECT_ID, q))).resolves.toBeInstanceOf(Array);
    }
    expect(await store.read((r) => r.search(PROJECT_ID, "   "))).toEqual([]);
  });

  it("matches any term when asked", async () => {
    await store.write((w) => w.insert("task", task({ title: "Kanban board" })));
    expect(await store.read((r) => r.search(PROJECT_ID, "kanban roadmap"))).toHaveLength(0);
    expect(
      await store.read((r) => r.search(PROJECT_ID, "kanban roadmap", { match: "any" })),
    ).toHaveLength(1);
  });
});

describe("activity", () => {
  it("appends and lists newest first", async () => {
    const mk = (id: string, at: string) => ({
      id,
      projectId: PROJECT_ID,
      actorId: "actr_01JC0000000000000000000000",
      verb: "create" as const,
      entity: "task",
      entityId: "tsk_01JC0000000000000000000001",
      diff: {},
      branch: null,
      at,
    });
    await store.write(async (w) => {
      await w.appendActivity(mk("act_01JC0000000000000000000001", "2026-11-03T10:00:00.000Z"));
      await w.appendActivity(mk("act_01JC0000000000000000000002", "2026-11-03T11:00:00.000Z"));
    });
    const list = await store.read((r) => r.listActivity(PROJECT_ID));
    expect(list.map((a) => a.id)).toEqual([
      "act_01JC0000000000000000000002",
      "act_01JC0000000000000000000001",
    ]);
  });
});

// Read budgets (150 ms p95) hold on large projects only if lists stop after `limit` rows
// instead of sorting every task. A temp B-tree in the plan means a full sort.
describe("query plans", () => {
  const plan = (sql: string): string =>
    (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join("\n");

  it("list and ready queries walk an index in (rank, id) order", () => {
    const order = "ORDER BY rank, id LIMIT 50";
    const queries = [
      `SELECT data FROM tasks WHERE project_id = 'p' AND deleted_at IS NULL ${order}`,
      `SELECT data FROM tasks WHERE project_id = 'p' AND status = 'todo' AND deleted_at IS NULL ${order}`,
      `SELECT data FROM notes WHERE project_id = 'p' AND deleted_at IS NULL ${order}`,
    ];
    for (const q of queries) expect(plan(q)).not.toContain("TEMP B-TREE");
  });
});
