import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import {
  type Activity,
  type ActivityQuery,
  type EntityMap,
  HANDOFF_TAG,
  type ListQuery,
  NO_SPACE_SCRIPT,
  type Note,
  PRIORITY_RANK,
  type Project,
  SatiError,
  SEARCHABLE,
  type SearchHit,
  type SearchOptions,
  type StorageAdapter,
  type StorageReader,
  type StorageWriter,
  type StoredEntity,
  splitWords,
  type Task,
} from "@sati/core";
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { buildFtsQuery } from "./fts.js";
import { LATEST_SCHEMA_VERSION, migrate, userVersion } from "./migrate.js";
import * as s from "./schema.js";

const TABLES: Record<StoredEntity, s.EntityTable> = {
  project: s.projects,
  milestone: s.milestones,
  feature: s.features,
  task: s.tasks,
  lock: s.locks,
  decision: s.decisions,
  note: s.notes,
  context: s.contextEntries,
  actor: s.actors,
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

type Row = typeof s.projects.$inferInsert;

/**
 * Notes have no status. Their `status` column marks handoffs instead, so a claim finds a task's
 * handoff by index rather than by reading every note (migration 0005 backfills it).
 */
const HANDOFF_UNREAD = "handoff";
const HANDOFF_READ = "handoff_read";

function noteStatus(note: Note): string | null {
  if (!note.tags.includes(HANDOFF_TAG)) return null;
  return note.acknowledged === undefined ? HANDOFF_UNREAD : HANDOFF_READ;
}

/** Copies the fields we query on out of the record into indexed columns. */
function toRow(entity: StoredEntity, rec: EntityMap[StoredEntity]): Row {
  const r = rec as unknown as Record<string, unknown>;
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
  let rank = 0;
  if (entity === "task") rank = PRIORITY_RANK[(rec as Task).priority];
  if (entity === "milestone") rank = (rec as EntityMap["milestone"]).order;
  return {
    id: rec.id,
    projectId: entity === "project" ? rec.id : (r.projectId as string),
    key: entity === "actor" ? str("name") : entity === "project" ? str("slug") : null,
    status: entity === "note" ? noteStatus(rec as Note) : str("status"),
    featureId: str("featureId"),
    milestoneId: str("milestoneId"),
    parentId: str("parentId"),
    claimLeaseUntil: entity === "task" ? ((rec as Task).claim?.leaseUntil ?? null) : null,
    rank,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    deletedAt: rec.deletedAt,
    version: rec.version,
    data: JSON.stringify(rec),
  };
}

const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

/** Extended result codes for a duplicate key. */
const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

/** The SQLite result code of `err` or its causes. Drizzle wraps driver errors. */
function sqliteErrcode(err: unknown): number | undefined {
  for (let e = err; e instanceof Error; e = e.cause) {
    if ("errcode" in e && typeof e.errcode === "number") return e.errcode;
  }
  return undefined;
}

/** Prepared statements kept per connection. Drizzle builds the same few hundred SQL strings. */
const STATEMENT_CACHE_SIZE = 256;

/**
 * Runs Drizzle's SQL on the connection, for Drizzle's `sqlite-proxy` driver (ADR 0003). That
 * driver wants rows as arrays of values, in column order.
 */
function proxy(db: DatabaseSync) {
  const cache = new Map<string, StatementSync>();
  const prepare = (query: string) => {
    let stmt = cache.get(query);
    if (stmt) {
      // Re-insert so the Map's insertion order is least recently used first.
      cache.delete(query);
    } else {
      stmt = db.prepare(query);
      stmt.setReturnArrays(true);
      if (cache.size >= STATEMENT_CACHE_SIZE) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
    }
    cache.set(query, stmt);
    return stmt;
  };
  return async (query: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
    const stmt = prepare(query);
    const args = params as SQLInputValue[];
    if (method === "run") {
      stmt.run(...args);
      return { rows: [] };
    }
    // `get` with no row gives `rows: undefined`, which the driver maps to `undefined`.
    if (method === "get") return { rows: stmt.get(...args) as unknown as unknown[] };
    return { rows: stmt.all(...args) as unknown[] };
  };
}

export interface OpenOptions {
  /** Open without migrating or writing (e.g. for `doctor`). */
  readonly?: boolean;
}

export class SqliteStore implements StorageAdapter {
  readonly db: DatabaseSync;
  readonly orm: SqliteRemoteDatabase;
  private readonly readOnly: boolean;
  /** Schema version found in the file at open time (after any migration). */
  readonly schemaVersion: number;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(db: DatabaseSync, readonly: boolean, schemaVersion: number) {
    this.db = db;
    this.orm = drizzle(proxy(db));
    this.readOnly = readonly;
    this.schemaVersion = schemaVersion;
  }

  static async open(path: string, opts: OpenOptions = {}): Promise<SqliteStore> {
    const readonly = opts.readonly ?? false;
    if (!readonly) mkdirSync(dirname(path), { recursive: true });
    let db: DatabaseSync;
    try {
      // `timeout` is SQLite's busy timeout: wait up to 5 s for another process's lock.
      db = new DatabaseSync(path, { readOnly: readonly, timeout: 5000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unable to open database file")) {
        throw new SatiError("USAGE", `Cannot open the database at ${path}.`, {
          hint: "This process needs write access to that file and its folder.",
        });
      }
      throw err;
    }
    if (!readonly) db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
    // Node builds SQLite with its 2 MB default page cache. 16 MB, as better-sqlite3 had, keeps
    // FTS updates and searches on large projects in memory (ADR 0003).
    db.exec("PRAGMA foreign_keys = ON; PRAGMA cache_size = -16000");
    const version = readonly ? userVersion(db) : await migrate(db, path);
    return new SqliteStore(db, readonly, version);
  }

  /** `PRAGMA integrity_check`: "ok", or the problems found, one per line. */
  integrityCheck(): Promise<string> {
    return this.exclusive(async () =>
      this.db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((r) => String(r.integrity_check))
        .join("\n"),
    );
  }

  /** `PRAGMA data_version`: changes when another connection commits to the file. */
  dataVersion(): number {
    return Number(this.db.prepare("PRAGMA data_version").get()?.data_version ?? 0);
  }

  /** Rebuilds the file to drop free pages. */
  vacuum(): Promise<void> {
    return this.exclusive(async () => {
      this.db.exec("VACUUM");
    });
  }

  /** Serialises callers in this process; SQLite locking handles other processes. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  read<T>(fn: (r: StorageReader) => Promise<T>): Promise<T> {
    // A deferred transaction pins one snapshot, so several reads in `fn` agree with each other.
    return this.exclusive(async () => {
      this.db.exec("BEGIN");
      try {
        const result = await fn(this.reader);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  write<T>(fn: (w: StorageWriter) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Checked inside the lock: another process may have upgraded the schema since we opened.
        const current = userVersion(this.db);
        if (current > LATEST_SCHEMA_VERSION) {
          throw new SatiError(
            "SCHEMA_TOO_NEW",
            `The database uses schema v${current}, but this sati only knows v${LATEST_SCHEMA_VERSION}.`,
            { hint: "A newer sati upgraded this project. Update sati and restart this process." },
          );
        }
        const result = await fn(this.writer);
        this.db.exec("COMMIT");
        return result;
      } catch (err) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      if (this.db.isOpen) {
        if (!this.readOnly) this.db.exec("PRAGMA optimize");
        this.db.close();
      }
    });
  }

  private readonly reader: StorageReader = {
    getProject: async () => {
      const row = await this.orm
        .select({ data: s.projects.data })
        .from(s.projects)
        .where(isNull(s.projects.deletedAt))
        .orderBy(asc(s.projects.id))
        .limit(1)
        .get();
      return row ? (JSON.parse(row.data) as Project) : undefined;
    },

    get: async <E extends StoredEntity>(entity: E, id: string) => {
      const t: s.EntityTable = TABLES[entity];
      const row = await this.orm.select({ data: t.data }).from(t).where(eq(t.id, id)).get();
      return row ? (JSON.parse(row.data) as EntityMap[E]) : undefined;
    },

    findBySuffix: async <E extends StoredEntity>(entity: E, suffix: string) => {
      const t: s.EntityTable = TABLES[entity];
      const rows = await this.orm
        .select({ data: t.data })
        .from(t)
        .where(
          sql`upper(${t.id}) LIKE ${`%${suffix.toUpperCase().replace(/[%_\\]/g, "\\$&")}`} ESCAPE '\\'`,
        )
        // The caller filters by project afterwards, so keep enough rows for that to be safe.
        .limit(100)
        .all();
      return rows.map((r) => JSON.parse(r.data) as EntityMap[E]);
    },

    getByKey: async <E extends StoredEntity>(entity: E, projectId: string, key: string) => {
      const t: s.EntityTable = TABLES[entity];
      const row = await this.orm
        .select({ data: t.data })
        .from(t)
        .where(and(eq(t.projectId, projectId), eq(t.key, key)))
        .get();
      return row ? (JSON.parse(row.data) as EntityMap[E]) : undefined;
    },

    list: async <E extends StoredEntity>(entity: E, projectId: string, q: ListQuery = {}) => {
      const t: s.EntityTable = TABLES[entity];
      const where: SQL[] = [eq(t.projectId, projectId)];
      if (!q.includeDeleted) where.push(isNull(t.deletedAt));
      if (q.status?.length) where.push(inArray(t.status, [...q.status]));
      if (q.handoff === "unread") where.push(eq(t.status, HANDOFF_UNREAD));
      if (q.handoff === "any") where.push(inArray(t.status, [HANDOFF_UNREAD, HANDOFF_READ]));
      if (q.featureId) where.push(eq(t.featureId, q.featureId));
      if (q.inMilestone) {
        const { milestoneId, featureIds } = q.inMilestone;
        const own = eq(t.milestoneId, milestoneId);
        const viaFeature = featureIds.length ? inArray(t.featureId, [...featureIds]) : undefined;
        where.push(viaFeature ? (or(own, viaFeature) ?? own) : own);
      }
      if (q.milestoneId) where.push(eq(t.milestoneId, q.milestoneId));
      if (q.parentId) where.push(eq(t.parentId, q.parentId));
      if (q.label) {
        where.push(
          sql`exists (select 1 from json_each(${t.data}, '$.labels') where value = ${q.label})`,
        );
      }
      // Matches the `locks_live_task` expression index (migration 0006).
      if (q.taskId) where.push(sql`json_extract(${t.data}, '$.taskId') = ${q.taskId}`);
      if (q.anyLabel) {
        const labels = q.anyLabel.length ? [...q.anyLabel] : [""];
        where.push(
          sql`exists (select 1 from json_each(${t.data}, '$.labels') where value in ${labels})`,
        );
      }
      if (q.path !== undefined) where.push(sql`json_extract(${t.data}, '$.path') = ${q.path}`);
      if (q.dueBy) where.push(sql`json_extract(${t.data}, '$.dueDate') <= ${q.dueBy}`);
      if (q.effort) {
        where.push(sql`coalesce(json_extract(${t.data}, '$.effort'), 'standard') = ${q.effort}`);
      }
      if (q.updatedSince) where.push(sql`${t.updatedAt} >= ${q.updatedSince}`);
      if (q.assigneeId) {
        where.push(
          sql`exists (select 1 from json_each(${t.data}, '$.assigneeIds') where value = ${q.assigneeId})`,
        );
      }
      if (q.after !== undefined) {
        const cursor = await this.orm
          .select({ rank: t.rank })
          .from(t)
          .where(and(eq(t.id, q.after), eq(t.projectId, projectId)))
          .get();
        if (!cursor) throw new SatiError("NOT_FOUND", `No ${entity} with id ${q.after}.`);
        // A row value keeps the (rank, id) index range, so SQLite seeks instead of skipping rows.
        where.push(
          q.newestFirst
            ? sql`(${t.rank}, ${t.id}) < (${cursor.rank}, ${q.after})`
            : sql`(${t.rank}, ${t.id}) > (${cursor.rank}, ${q.after})`,
        );
      }
      const rows = await this.orm
        .select({ data: t.data })
        .from(t)
        .where(and(...where))
        .orderBy(...(q.newestFirst ? [desc(t.rank), desc(t.id)] : [asc(t.rank), asc(t.id)]))
        .limit(clampLimit(q.limit))
        .offset(q.offset ?? 0)
        .all();
      return rows.map((r) => JSON.parse(r.data) as EntityMap[E]);
    },

    readyTasks: async (projectId, now, limit, after) => {
      const t = s.tasks;
      const cursor =
        after === undefined
          ? undefined
          : await this.orm
              .select({ rank: t.rank })
              .from(t)
              .where(and(eq(t.id, after), eq(t.projectId, projectId)))
              .get();
      if (after !== undefined && !cursor) {
        throw new SatiError("NOT_FOUND", `No task with id ${after}.`);
      }
      const rows = await this.orm
        .select({ data: t.data })
        .from(t)
        .where(
          and(
            eq(t.projectId, projectId),
            eq(t.status, "todo"),
            isNull(t.deletedAt),
            sql`(${t.claimLeaseUntil} IS NULL OR ${t.claimLeaseUntil} <= ${now})`,
            // A done, cancelled or deleted dependency no longer blocks; a missing one still does
            // (dep.status is NULL for it, and NULL is not in the list).
            sql`NOT EXISTS (
              SELECT 1 FROM json_each(${t.data}, '$.dependsOn') d
              LEFT JOIN tasks dep ON dep.id = d.value
              WHERE (dep.status IS NULL OR dep.status NOT IN ('done', 'cancelled'))
                AND dep.deleted_at IS NULL)`,
            cursor ? sql`(${t.rank}, ${t.id}) > (${cursor.rank}, ${after})` : undefined,
          ),
        )
        .orderBy(asc(t.rank), asc(t.id))
        .limit(clampLimit(limit))
        .all();
      return rows.map((r) => JSON.parse(r.data) as Task);
    },

    search: async (projectId: string, query: string, opts: SearchOptions = {}) => {
      const entities = opts.entities?.length ? opts.entities : SEARCHABLE;
      if (NO_SPACE_SCRIPT.test(query)) {
        // The index splits on spaces and marks: a Chinese sentence is one token there and a
        // Thai word is cut at its tone marks, so MATCH finds neither. These queries scan the
        // indexed text for each word instead; a project's memory is small enough for that.
        const words = [...new Set(splitWords(query))].slice(0, 32);
        if (words.length === 0) return [];
        const holds = "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')";
        const like = words.flatMap((w) => {
          const p = `%${w.replace(/[\\%_]/gu, "\\$&")}%`;
          return [p, p];
        });
        const count = words.map(() => holds).join(" + ");
        const rows = this.db
          .prepare(
            `SELECT entity, id, title, substr(body, 1, 120) AS snippet, -(${count}) AS rank
             FROM search_fts
             WHERE project_id = ? AND entity IN (${entities.map(() => "?").join(",")})
               AND (${count}) >= ?
             ORDER BY rank, rowid DESC LIMIT ?`,
          )
          .all(
            ...like,
            projectId,
            ...entities,
            ...like,
            (opts.match ?? "all") === "all" ? words.length : 1,
            clampLimit(opts.limit),
          );
        return rows.map((r) => ({ ...r }) as unknown as SearchHit);
      }
      const match = buildFtsQuery(query, opts.match ?? "all");
      if (!match) return [];
      const rows = this.db
        .prepare(
          `SELECT entity, id, title,
             snippet(search_fts, 4, '[', ']', '…', 12) AS snippet,
             bm25(search_fts, 0, 0, 0, 5.0, 1.0) AS rank
           FROM search_fts
           WHERE search_fts MATCH ? AND project_id = ?
             AND entity IN (${entities.map(() => "?").join(",")})
           ORDER BY rank LIMIT ?`,
        )
        .all(match, projectId, ...entities, clampLimit(opts.limit));
      // node:sqlite rows have a null prototype; callers get plain objects.
      return rows.map((r) => ({ ...r }) as unknown as SearchHit);
    },

    listActivity: async (projectId: string, q: ActivityQuery = {}) => {
      const a = s.activity;
      const where: SQL[] = [eq(a.projectId, projectId)];
      if (q.entityId) where.push(eq(a.entityId, q.entityId));
      if (q.actorId) where.push(eq(a.actorId, q.actorId));
      if (q.actorIds) {
        if (q.actorIds.length === 0) return [];
        where.push(inArray(a.actorId, [...q.actorIds]));
      }
      // The verb is not a column: the few callers that ask also bound the rows by time.
      if (q.verb) where.push(sql`json_extract(${a.data}, '$.verb') = ${q.verb}`);
      if (q.since) where.push(sql`${a.at} >= ${q.since}`);
      if (q.after !== undefined) {
        // Rows are appended inside the write transaction and writers queue, so rowid order is
        // commit order. Ids and `at` come from each process's clock and can disagree with it.
        // VACUUM may renumber rowids but keeps their order, and the cursor is looked up by id.
        const cursor = await this.orm
          .select({ seq: sql<number>`rowid` })
          .from(a)
          .where(and(eq(a.id, q.after), eq(a.projectId, projectId)))
          .get();
        if (!cursor) {
          throw new SatiError("NOT_FOUND", `No activity with id ${q.after}.`, {
            hint: "Start again without a cursor; the row may have been compacted.",
          });
        }
        where.push(sql`rowid > ${cursor.seq}`);
        const rows = await this.orm
          .select({ data: a.data })
          .from(a)
          .where(and(...where))
          .orderBy(sql`rowid`)
          .limit(clampLimit(q.limit))
          .all();
        return rows.map((r) => JSON.parse(r.data) as Activity);
      }
      const rows = await this.orm
        .select({ data: a.data })
        .from(a)
        .where(and(...where))
        .orderBy(desc(a.at), desc(a.id))
        .limit(clampLimit(q.limit))
        .all();
      return rows.map((r) => JSON.parse(r.data) as Activity);
    },

    getActivity: async (id: string) => {
      const row = await this.orm
        .select({ data: s.activity.data })
        .from(s.activity)
        .where(eq(s.activity.id, id))
        .get();
      return row ? (JSON.parse(row.data) as Activity) : undefined;
    },
  };

  private readonly writer: StorageWriter = {
    ...this.reader,

    insert: async (entity, record) => {
      try {
        const t: s.EntityTable = TABLES[entity];
        await this.orm.insert(t).values(toRow(entity, record)).run();
      } catch (err) {
        const code = sqliteErrcode(err);
        if (code === SQLITE_CONSTRAINT_PRIMARYKEY || code === SQLITE_CONSTRAINT_UNIQUE) {
          throw new SatiError("CONFLICT", `${entity} ${record.id} already exists`);
        }
        throw err;
      }
    },

    update: async (entity, record, expectedVersion) => {
      const t: s.EntityTable = TABLES[entity];
      const { id: _id, ...row } = toRow(entity, record);
      let changed: { id: string }[];
      try {
        changed = await this.orm
          .update(t)
          .set(row)
          .where(and(eq(t.id, record.id), eq(t.version, expectedVersion)))
          .returning({ id: t.id })
          .all();
      } catch (err) {
        // Renaming an actor (or a project slug) to a key another record holds.
        if (sqliteErrcode(err) === SQLITE_CONSTRAINT_UNIQUE) {
          throw new SatiError("CONFLICT", `Another ${entity} already uses that name.`);
        }
        throw err;
      }
      if (changed.length !== 1) {
        throw new SatiError(
          "CONFLICT",
          `${entity} ${record.id} was changed by someone else (expected version ${expectedVersion})`,
          { hint: "Fetch it again and retry your change." },
        );
      }
    },

    appendActivity: async (a) => {
      await this.orm
        .insert(s.activity)
        .values({
          id: a.id,
          projectId: a.projectId,
          actorId: a.actorId,
          entity: a.entity,
          entityId: a.entityId,
          at: a.at,
          data: JSON.stringify(a),
        })
        .run();
    },
  };
}
