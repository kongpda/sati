import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Activity,
  type ActivityQuery,
  type EntityMap,
  type ListQuery,
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
  type Task,
} from "@sati/core";
import Database from "better-sqlite3";
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { buildFtsQuery } from "./fts.js";
import { LATEST_SCHEMA_VERSION, migrate } from "./migrate.js";
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
    status: str("status"),
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

export interface OpenOptions {
  /** Open without migrating or writing (e.g. for `doctor`). */
  readonly?: boolean;
  /** Directory for pre-migration backups. Defaults to next to the DB. */
  backupDir?: string;
}

export class SqliteStore implements StorageAdapter {
  readonly db: Database.Database;
  readonly orm: BetterSQLite3Database;
  /** Schema version found in the file at open time (after any migration). */
  readonly schemaVersion: number;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(db: Database.Database, schemaVersion: number) {
    this.db = db;
    this.orm = drizzle(db);
    this.schemaVersion = schemaVersion;
  }

  static async open(path: string, opts: OpenOptions = {}): Promise<SqliteStore> {
    if (!opts.readonly) mkdirSync(dirname(path), { recursive: true });
    let db: Database.Database;
    try {
      db = new Database(path, { readonly: opts.readonly ?? false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("unable to open database file")) {
        throw new SatiError("USAGE", `Cannot open the database at ${path}.`, {
          hint: "This process needs write access to that file and its folder.",
        });
      }
      throw err;
    }
    if (!opts.readonly) {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
    }
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    const version = opts.readonly
      ? (db.pragma("user_version", { simple: true }) as number)
      : await migrate(db, path, opts.backupDir);
    return new SqliteStore(db, version);
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
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  write<T>(fn: (w: StorageWriter) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Checked inside the lock: another process may have upgraded the schema since we opened.
        const current = this.db.pragma("user_version", { simple: true }) as number;
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
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.exclusive(async () => {
      if (this.db.open) {
        if (!this.db.readonly) this.db.pragma("optimize");
        this.db.close();
      }
    });
  }

  private readonly reader: StorageReader = {
    getProject: async () => {
      const row = this.orm
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
      const row = this.orm.select({ data: t.data }).from(t).where(eq(t.id, id)).get();
      return row ? (JSON.parse(row.data) as EntityMap[E]) : undefined;
    },

    findBySuffix: async <E extends StoredEntity>(entity: E, suffix: string) => {
      const t: s.EntityTable = TABLES[entity];
      const rows = this.orm
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
      const row = this.orm
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
      if (q.dueBy) where.push(sql`json_extract(${t.data}, '$.dueDate') <= ${q.dueBy}`);
      if (q.assigneeId) {
        where.push(
          sql`exists (select 1 from json_each(${t.data}, '$.assigneeIds') where value = ${q.assigneeId})`,
        );
      }
      const rows = this.orm
        .select({ data: t.data })
        .from(t)
        .where(and(...where))
        .orderBy(...(q.newestFirst ? [desc(t.rank), desc(t.id)] : [asc(t.rank), asc(t.id)]))
        .limit(clampLimit(q.limit))
        .offset(q.offset ?? 0)
        .all();
      return rows.map((r) => JSON.parse(r.data) as EntityMap[E]);
    },

    readyTasks: async (projectId, now, limit) => {
      const t = s.tasks;
      const rows = this.orm
        .select({ data: t.data })
        .from(t)
        .where(
          and(
            eq(t.projectId, projectId),
            eq(t.status, "todo"),
            isNull(t.deletedAt),
            sql`(${t.claimLeaseUntil} IS NULL OR ${t.claimLeaseUntil} <= ${now})`,
            // A deleted dependency no longer blocks; a missing one still does.
            sql`NOT EXISTS (
              SELECT 1 FROM json_each(${t.data}, '$.dependsOn') d
              LEFT JOIN tasks dep ON dep.id = d.value
              WHERE dep.status IS NOT 'done' AND dep.deleted_at IS NULL)`,
          ),
        )
        .orderBy(asc(t.rank), asc(t.id))
        .limit(clampLimit(limit))
        .all();
      return rows.map((r) => JSON.parse(r.data) as Task);
    },

    search: async (projectId: string, query: string, opts: SearchOptions = {}) => {
      const match = buildFtsQuery(query, opts.match ?? "all");
      if (!match) return [];
      const entities = opts.entities?.length ? opts.entities : SEARCHABLE;
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
        .all(match, projectId, ...entities, clampLimit(opts.limit)) as SearchHit[];
      return rows;
    },

    listActivity: async (projectId: string, q: ActivityQuery = {}) => {
      const a = s.activity;
      const where: SQL[] = [eq(a.projectId, projectId)];
      if (q.entityId) where.push(eq(a.entityId, q.entityId));
      if (q.actorId) where.push(eq(a.actorId, q.actorId));
      if (q.since) where.push(sql`${a.at} >= ${q.since}`);
      const rows = this.orm
        .select({ data: a.data })
        .from(a)
        .where(and(...where))
        .orderBy(desc(a.at), desc(a.id))
        .limit(clampLimit(q.limit))
        .all();
      return rows.map((r) => JSON.parse(r.data) as Activity);
    },

    getActivity: async (id: string) => {
      const row = this.orm
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
        this.orm.insert(t).values(toRow(entity, record)).run();
      } catch (err) {
        if (
          err instanceof Database.SqliteError &&
          (err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || err.code === "SQLITE_CONSTRAINT_UNIQUE")
        ) {
          throw new SatiError("CONFLICT", `${entity} ${record.id} already exists`);
        }
        throw err;
      }
    },

    update: async (entity, record, expectedVersion) => {
      const t: s.EntityTable = TABLES[entity];
      const { id: _id, ...row } = toRow(entity, record);
      const res = this.orm
        .update(t)
        .set(row)
        .where(and(eq(t.id, record.id), eq(t.version, expectedVersion)))
        .run();
      if (res.changes !== 1) {
        throw new SatiError(
          "CONFLICT",
          `${entity} ${record.id} was changed by someone else (expected version ${expectedVersion})`,
          { hint: "Fetch it again and retry your change." },
        );
      }
    },

    appendActivity: async (a) => {
      this.orm
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
