import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SatiError } from "@sati/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.gen.js";
import { ACTOR, NOW, note, PROJECT_ID, pragma, project, task, tmpDb } from "./fixtures.js";

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
    expect(pragma(store.db, "journal_mode")).toBe("wal");
    expect(pragma(store.db, "busy_timeout")).toBe(5000);
  });

  // Upgrades must be reversible: a failed or bad migration should never lose the user's data.
  it("backs up an existing DB before migrating it", async () => {
    const v1 = tmpDb();
    const raw = new DatabaseSync(v1);
    raw.exec(MIGRATIONS[0]?.sql ?? "");
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    const upgraded = await SqliteStore.open(v1);
    expect(upgraded.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    await upgraded.close();
    const backups = readdirSync(join(dirname(v1), "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^sati\.db\.v1\..+\.bak$/);
  });

  it("does not back up a brand-new DB", () => {
    expect(existsSync(join(dirname(path), "backups"))).toBe(false);
  });

  // An old MCP server still running after an upgrade must not write with the old schema.
  it("refuses writes when a newer binary has upgraded the schema", async () => {
    store.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    const err = await store.write((w) => w.insert("task", task())).catch((e) => e);
    expect(err).toBeInstanceOf(SatiError);
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
    const reversed = await store.read((r) =>
      r.list("task", PROJECT_ID, { status: ["todo"], newestFirst: true }),
    );
    expect(reversed.map((t) => t.id)).toEqual([low.id, urgent.id]);
  });

  it("finds a milestone's tasks directly or through their feature, and no others", async () => {
    const M = "mil_01JC0000000000000000000001";
    const F = "feat_01JC000000000000000000001";
    const own = task({ milestoneId: M });
    const viaFeature = task({ featureId: F });
    const elsewhere = task({ milestoneId: "mil_01JC0000000000000000000002" });
    const loose = task();
    await store.write(async (w) => {
      for (const t of [own, viaFeature, elsewhere, loose]) await w.insert("task", t);
    });
    const ids = async (featureIds: string[]) =>
      (
        await store.read((r) =>
          r.list("task", PROJECT_ID, { inMilestone: { milestoneId: M, featureIds } }),
        )
      ).map((t) => t.id);
    expect((await ids([F])).sort()).toEqual([own.id, viaFeature.id].sort());
    // A milestone with no features still finds its own tasks.
    expect(await ids([])).toEqual([own.id]);
  });

  it("finds records by short-handle suffix", async () => {
    const t = task();
    await store.write((w) => w.insert("task", t));
    const hits = await store.read((r) => r.findBySuffix("task", t.id.slice(-6).toLowerCase()));
    expect(hits.map((h) => h.id)).toEqual([t.id]);
  });

  // A suffix typed as "%" must not turn into a match-everything wildcard that resolves a wrong id.
  it("treats LIKE wildcards in a suffix literally", async () => {
    await store.write(async (w) => {
      await w.insert("task", task());
      await w.insert("task", task());
    });
    expect(await store.read((r) => r.findBySuffix("task", "%"))).toHaveLength(0);
    expect(await store.read((r) => r.findBySuffix("task", "_"))).toHaveLength(0);
  });

  // The caller filters by project after the lookup, so a small cap could hide the real match.
  it("returns more than ten suffix candidates", async () => {
    await store.write(async (w) => {
      for (let i = 0; i < 15; i++) await w.insert("task", task({ id: `tsk_${i}SAME` }));
    });
    expect(await store.read((r) => r.findBySuffix("task", "same"))).toHaveLength(15);
  });

  // `read` promises one consistent snapshot: a commit from another process mid-read must not show.
  it("gives a read one snapshot even if another connection commits meanwhile", async () => {
    const other = await SqliteStore.open(path);
    try {
      const [before, after] = await store.read(async (r) => {
        const first = await r.list("task", PROJECT_ID);
        await other.write((w) => w.insert("task", task()));
        return [first, await r.list("task", PROJECT_ID)] as const;
      });
      expect(after).toHaveLength(before.length);
      expect(await store.read((r) => r.list("task", PROJECT_ID))).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  // A read that throws must release its snapshot, or the next write could never see new data.
  it("ends the read transaction when the read throws", async () => {
    await store
      .read(async () => {
        throw new Error("boom");
      })
      .catch(() => undefined);
    expect(store.db.isTransaction).toBe(false);
  });

  // Only duplicate keys mean "already exists"; other constraint failures are different bugs.
  it("reports a duplicate id as CONFLICT but not other constraint errors", async () => {
    const t = task();
    await store.write((w) => w.insert("task", t));
    const dup = await store.write((w) => w.insert("task", t)).catch((e) => e);
    expect(dup).toBeInstanceOf(SatiError);
    expect(dup.code).toBe("CONFLICT");
    const bad = await store
      .write((w) => w.insert("task", task({ createdAt: undefined as unknown as string })))
      .catch((e) => e);
    expect(bad).not.toBeInstanceOf(SatiError);
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

    // Cancelling the dependency unblocks the task, and so does deleting it; a dependency that
    // was never there still blocks.
    await store.write((w) => w.update("task", { ...dep, status: "cancelled", version: 3 }, 2));
    const cancelled = await store.read((r) => r.readyTasks(PROJECT_ID, NOW, 10));
    expect(cancelled.map((t) => t.id)).toContain(blockedByDep.id);
    await store.write((w) =>
      w.update("task", { ...dep, status: "review", deletedAt: NOW, version: 4 }, 3),
    );
    const missing = task({ dependsOn: ["tsk_01JC0000000000000000000ZZZ"] });
    await store.write((w) => w.insert("task", missing));
    const unblocked = await store.read((r) => r.readyTasks(PROJECT_ID, NOW, 10));
    expect(unblocked.map((t) => t.id)).toContain(blockedByDep.id);
    expect(unblocked.map((t) => t.id)).not.toContain(missing.id);
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

  // PLAN Phase 5b: punctuation inside a word splits it the way the index does, so a version, a
  // file name or a date finds the record, and a different one does not.
  it("finds words with punctuation inside them, such as v1.2 and auth.ts", async () => {
    await store.write(async (w) => {
      await w.insert("note", note({ title: "Release v1.2 notes", body: "Touches src/auth.ts" }));
      await w.insert("note", note({ title: "Release v1.3 notes" }));
    });
    const titles = async (q: string) =>
      (await store.read((r) => r.search(PROJECT_ID, q))).map((h) => h.title);
    expect(await titles("v1.2")).toEqual(["Release v1.2 notes"]);
    expect(await titles("auth.ts")).toEqual(["Release v1.2 notes"]);
    expect(await titles("v1.")).toHaveLength(2);
    // Quotes and operators stay plain text.
    expect(await titles('v1.2" OR "v1.3')).toEqual([]);
  });

  it("drops soft-deleted records from the index", async () => {
    const t = task({ title: "Ephemeral" });
    await store.write((w) => w.insert("task", t));
    await store.write((w) => w.update("task", { ...t, deletedAt: NOW, version: 2 }, 1));
    expect(await store.read((r) => r.search(PROJECT_ID, "ephemeral"))).toEqual([]);
  });

  // Updates find the index row by rowid (search_rowids). An edit must replace the old text,
  // and a hard delete must drop both the index row and its rowid entry.
  it("keeps exactly one index row per record across edits and deletes", async () => {
    const t = task({ title: "Old words" });
    await store.write((w) => w.insert("task", t));
    await store.write((w) => w.update("task", { ...t, title: "New words", version: 2 }, 1));
    expect(await store.read((r) => r.search(PROJECT_ID, "old"))).toEqual([]);
    expect(await store.read((r) => r.search(PROJECT_ID, "new"))).toHaveLength(1);
    store.db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
    const count = (sql: string) => store.db.prepare(sql).get()?.n;
    expect(count("SELECT count(*) AS n FROM search_fts")).toBe(0);
    expect(count("SELECT count(*) AS n FROM search_rowids")).toBe(0);
  });

  // Records indexed before migration 0003 have no search_rowids entry until it backfills them;
  // without the backfill their edits would leave stale text in the index.
  it("upgrading from schema v3 keeps existing records searchable and editable", async () => {
    const v3 = tmpDb();
    const raw = new DatabaseSync(v3);
    for (const m of MIGRATIONS.slice(0, 3)) raw.exec(m.sql);
    raw.exec("PRAGMA user_version = 3");
    const t = task({ title: "Legacy title" });
    raw
      .prepare(
        "INSERT INTO tasks (id, project_id, status, rank, created_at, updated_at, version, data) VALUES (?, ?, 'todo', 0, ?, ?, 1, ?)",
      )
      .run(t.id, PROJECT_ID, NOW, NOW, JSON.stringify(t));
    raw.close();
    const upgraded = await SqliteStore.open(v3);
    try {
      expect(await upgraded.read((r) => r.search(PROJECT_ID, "legacy"))).toHaveLength(1);
      await upgraded.write((w) => w.update("task", { ...t, title: "Renamed", version: 2 }, 1));
      expect(await upgraded.read((r) => r.search(PROJECT_ID, "legacy"))).toEqual([]);
      expect(await upgraded.read((r) => r.search(PROJECT_ID, "renamed"))).toHaveLength(1);
    } finally {
      await upgraded.close();
    }
  });

  // PLAN Phase 8: cards are found by path, summary, facts and tags, including cards written
  // before migration 0004 added them to the index.
  it("indexes cards, also those written before the cards migration", async () => {
    const card = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
      id,
      projectId: PROJECT_ID,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "actr_01J0000000000000000000000A",
      version: 1,
      deletedAt: null,
      path,
      summary: "Quote from the hall",
      keyFiles: [],
      contentHash: "",
      gitCommit: null,
      ...extra,
    });
    const v4 = tmpDb();
    const raw = new DatabaseSync(v4);
    for (const m of MIGRATIONS.slice(0, 4)) raw.exec(m.sql);
    raw.exec("PRAGMA user_version = 4");
    const old = card("ctx_01J0000000000000000000000B", "venue/old.pdf", { facts: ["Parking 40"] });
    raw
      .prepare(
        "INSERT INTO context_entries (id, project_id, rank, created_at, updated_at, version, data) VALUES (?, ?, 0, ?, ?, 1, ?)",
      )
      .run(old.id, PROJECT_ID, NOW, NOW, JSON.stringify(old));
    raw.close();
    const upgraded = await SqliteStore.open(v4);
    try {
      const find = async (q: string) =>
        (await upgraded.read((r) => r.search(PROJECT_ID, q))).map((h) => `${h.entity} ${h.title}`);
      expect(await find("parking")).toEqual(["context venue/old.pdf"]);
      const fresh = card("ctx_01J0000000000000000000000C", "brand/logo.pdf", { tags: ["brand"] });
      await upgraded.write((w) => w.insert("context", fresh as never));
      expect(await find("brand")).toEqual(["context brand/logo.pdf"]);
      await upgraded.write((w) =>
        w.update("context", { ...old, facts: ["Parking 60"], version: 2 } as never, 1),
      );
      expect(await find("60")).toEqual(["context venue/old.pdf"]);
      expect(await find("40")).toEqual([]);
    } finally {
      await upgraded.close();
    }
  });

  // A claim finds its task's handoff through the notes' status column. Handoffs written before
  // schema v6 must be marked by the migration, or the next claim would never deliver them.
  it("finds handoff notes by index, including ones written before schema v6", async () => {
    const v4 = tmpDb();
    const raw = new DatabaseSync(v4);
    for (const m of MIGRATIONS.slice(0, 5)) raw.exec(m.sql);
    raw.exec("PRAGMA user_version = 5");
    const acknowledged = { by: ACTOR, at: NOW };
    const unread = note({ tags: ["handoff"] });
    const read = note({ tags: ["handoff"], acknowledged });
    const other = note({ tags: ["idea", "handoffs"] });
    const insert = raw.prepare(
      "INSERT INTO notes (id, project_id, rank, created_at, updated_at, version, data) VALUES (?, ?, 0, ?, ?, 1, ?)",
    );
    for (const n of [unread, read, other])
      insert.run(n.id, PROJECT_ID, NOW, NOW, JSON.stringify(n));
    raw.close();
    const upgraded = await SqliteStore.open(v4);
    const handoffs = async (handoff: "unread" | "any") =>
      (await upgraded.read((r) => r.list("note", PROJECT_ID, { handoff }))).map((n) => n.id).sort();
    try {
      expect(await handoffs("unread")).toEqual([unread.id]);
      expect(await handoffs("any")).toEqual([unread.id, read.id].sort());
      await upgraded.write((w) => w.update("note", { ...unread, acknowledged, version: 2 }, 1));
      expect(await handoffs("unread")).toEqual([]);
      // Rewriting a handoff clears `acknowledged`, which makes it unread again.
      await upgraded.write((w) => w.update("note", { ...read, version: 2 }, 1));
      expect(await handoffs("unread")).toEqual([]);
      const { acknowledged: _, ...rewritten } = read;
      await upgraded.write((w) => w.update("note", { ...rewritten, version: 3 }, 2));
      expect(await handoffs("unread")).toEqual([read.id]);
    } finally {
      await upgraded.close();
    }
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

  // A reader resuming from a cursor must see every later write once, even when another
  // process's clock made its ids and times sort before rows it already read.
  it("resumes after a cursor in commit order, not id or time order", async () => {
    const mk = (n: number, at: string) => ({
      id: `act_01JC000000000000000000000${n}`,
      projectId: PROJECT_ID,
      actorId: "actr_01JC0000000000000000000000",
      verb: "create" as const,
      entity: "task",
      entityId: "tsk_01JC0000000000000000000001",
      diff: {},
      branch: null,
      at,
    });
    await store.write((w) => w.appendActivity(mk(5, "2026-11-03T12:00:00.000Z")));
    await store.write((w) => w.appendActivity(mk(3, "2026-11-03T11:00:00.000Z")));
    await store.write((w) => w.appendActivity(mk(9, "2026-11-03T13:00:00.000Z")));
    await store.write((w) => w.appendActivity(mk(1, "2026-11-03T10:00:00.000Z")));
    const after = (id: string, limit?: number) =>
      store.read((r) => r.listActivity(PROJECT_ID, { after: id, limit }));
    expect((await after(mk(5, "").id)).map((a) => a.id.at(-1))).toEqual(["3", "9", "1"]);
    expect((await after(mk(3, "").id, 1)).map((a) => a.id.at(-1))).toEqual(["9"]);
    expect(await after(mk(1, "").id)).toEqual([]);
    await expect(after("act_01JC0000000000000000000007")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

// Read budgets (150 ms p95) hold on large projects only if lists stop after `limit` rows
// instead of sorting every task. A temp B-tree in the plan means a full sort.
describe("query plans", () => {
  const plan = (sql: string): string =>
    store.db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((r) => String(r.detail))
      .join("\n");

  it("list and ready queries walk an index in (rank, id) order", () => {
    const order = "ORDER BY rank, id LIMIT 50";
    const queries = [
      `SELECT data FROM tasks WHERE project_id = 'p' AND deleted_at IS NULL ${order}`,
      `SELECT data FROM tasks WHERE project_id = 'p' AND status = 'todo' AND deleted_at IS NULL ${order}`,
      `SELECT data FROM notes WHERE project_id = 'p' AND deleted_at IS NULL ${order}`,
      // The brief reads the newest decisions; walking the same index backwards avoids a sort.
      `SELECT data FROM decisions WHERE project_id = 'p' AND deleted_at IS NULL ORDER BY rank DESC, id DESC LIMIT 10`,
    ];
    for (const q of queries) expect(plan(q)).not.toContain("TEMP B-TREE");
  });

  // listAll pages with `after`. Skipping rows with OFFSET made reading every page quadratic.
  it("a cursor page seeks into the (rank, id) index", () => {
    const after = "AND (rank, id) > (1, 'x') ORDER BY rank, id LIMIT 500";
    const q = `SELECT data FROM tasks WHERE project_id = 'p' AND deleted_at IS NULL ${after}`;
    expect(plan(q)).toContain("(rank,id)>(?,?)");
    expect(plan(q)).not.toContain("TEMP B-TREE");
  });
});

// Tasks of one priority share a rank, so a cursor on rank alone would skip or repeat them.
describe("cursor paging", () => {
  it("pages through equal ranks in both directions without gaps or repeats", async () => {
    const priorities = ["high", "medium", "medium", "medium", "low", "medium", "high"] as const;
    for (const priority of priorities)
      await store.write((w) => w.insert("task", task({ priority })));
    const pages = async (newestFirst: boolean) => {
      const seen: string[] = [];
      for (let after: string | undefined; ; ) {
        const page = await store.read((r) =>
          r.list("task", PROJECT_ID, { limit: 2, after, newestFirst }),
        );
        seen.push(...page.map((t) => t.id));
        after = page.at(-1)?.id;
        if (page.length < 2) return seen;
      }
    };
    const all = (newestFirst: boolean) =>
      store
        .read((r) => r.list("task", PROJECT_ID, { newestFirst }))
        .then((l) => l.map((t) => t.id));
    expect(await pages(false)).toEqual(await all(false));
    expect(await pages(true)).toEqual(await all(true));
    expect(new Set(await pages(false)).size).toBe(priorities.length);
  });

  it("refuses a cursor that is not in the project", async () => {
    const err = await store
      .read((r) => r.list("task", PROJECT_ID, { after: "tsk_missing" }))
      .catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND" });
  });
});
