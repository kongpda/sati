import {
  type Activity,
  type EntityMap,
  HANDOFF_TAG,
  PRIORITY_RANK,
  type Project,
  SatiError,
  SEARCHABLE,
  type SearchHit,
  type StorageAdapter,
  type StorageWriter,
  type StoredEntity,
  type Task,
} from "../../src/index.js";

/** The SQL store's readiness rule: todo, no live claim, every dependency done or cancelled. */
function ready(t: Task, depStatus: (id: string) => Task["status"] | undefined, now: string) {
  if (t.deletedAt !== null || t.status !== "todo") return false;
  if (t.claim !== null && t.claim.leaseUntil > now) return false;
  return t.dependsOn.every((id) => ["done", "cancelled"].includes(depStatus(id) ?? ""));
}

interface State {
  records: Map<StoredEntity, Map<string, EntityMap[StoredEntity]>>;
  activity: Activity[];
}

type AnyRecord = EntityMap[StoredEntity] & Record<string, unknown>;

/** Like SQL's DEFAULT_LIMIT and MAX_LIMIT: 50 rows unless asked, never more than 500. */
const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? 50, 1), 500);

/** The SQL store's `rank` column: priority for tasks, `order` for milestones, 0 otherwise. */
function rankOf(e: StoredEntity, r: AnyRecord): number {
  if (e === "task") return PRIORITY_RANK[(r as unknown as Task).priority];
  if (e === "milestone") return Number(r.order);
  return 0;
}

/** The unique `key` column: actor name or project slug. */
const keyOf = (e: StoredEntity, r: AnyRecord): unknown =>
  e === "actor" ? r.name : e === "project" ? r.slug : undefined;

/** Orders by (rank, id), as the SQL store's index does. */
const byRankThenId = (e: StoredEntity) => (a: AnyRecord, b: AnyRecord) =>
  rankOf(e, a) - rankOf(e, b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * In-memory StorageAdapter for core tests. Writes run on a copy that replaces the state only
 * when the callback succeeds, matching the SQLite adapter's all-or-nothing transactions.
 */
export class MemoryStore implements StorageAdapter {
  private state: State = { records: new Map(), activity: [] };
  private queue: Promise<unknown> = Promise.resolve();

  get activity(): readonly Activity[] {
    return this.state.activity;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  read<T>(fn: (r: StorageWriter) => Promise<T>): Promise<T> {
    return this.exclusive(() => fn(this.access(this.state)));
  }

  write<T>(fn: (w: StorageWriter) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      // Records are cloned on the way in and out and never changed in place, so copying each
      // table is enough to roll back. A deep clone per write made large tests quadratic.
      const draft: State = {
        records: new Map([...this.state.records].map(([e, t]) => [e, new Map(t)])),
        activity: [...this.state.activity],
      };
      const result = await fn(this.access(draft));
      this.state = draft;
      return result;
    });
  }

  async close(): Promise<void> {}

  private access(s: State): StorageWriter {
    const table = (e: StoredEntity) => {
      let t = s.records.get(e);
      if (!t) {
        t = new Map();
        s.records.set(e, t);
      }
      return t as Map<string, AnyRecord>;
    };
    const live = (e: StoredEntity, projectId: string) =>
      [...table(e).values()].filter(
        (r) => (r.projectId ?? r.id) === projectId && r.deletedAt === null,
      );
    const clone = <T>(v: T): T => structuredClone(v);
    /** The SQL unique index on (project, key): another record holding the key is a conflict. */
    const uniqueKey = (e: StoredEntity, rec: AnyRecord) => {
      const key = keyOf(e, rec);
      if (key === undefined) return;
      const pid = rec.projectId ?? rec.id;
      for (const r of table(e).values()) {
        if (r.id !== rec.id && (r.projectId ?? r.id) === pid && keyOf(e, r) === key) {
          throw new SatiError("CONFLICT", `${e} ${String(key)} already exists`);
        }
      }
    };
    return {
      getProject: async () =>
        clone(
          [...table("project").values()]
            .filter((p) => p.deletedAt === null)
            .sort(byRankThenId("project"))[0] as Project | undefined,
        ),
      get: async (e, id) => clone(table(e).get(id)) as never,
      findBySuffix: async (e, suffix) =>
        [...table(e).values()]
          .filter((r) => r.id.toLowerCase().endsWith(suffix.toLowerCase()))
          .map(clone) as never,
      list: async (e, projectId, q = {}) => {
        let rows = q.includeDeleted
          ? [...table(e).values()].filter((r) => (r.projectId ?? r.id) === projectId)
          : live(e, projectId);
        if (q.status) rows = rows.filter((r) => q.status?.includes(String(r.status)));
        if (q.featureId) rows = rows.filter((r) => r.featureId === q.featureId);
        if (q.parentId) rows = rows.filter((r) => r.parentId === q.parentId);
        if (q.inMilestone) {
          const { milestoneId, featureIds } = q.inMilestone;
          rows = rows.filter(
            (r) => r.milestoneId === milestoneId || featureIds.includes(String(r.featureId)),
          );
        }
        if (q.milestoneId) rows = rows.filter((r) => r.milestoneId === q.milestoneId);
        if (q.label) rows = rows.filter((r) => (r.labels as string[]).includes(q.label ?? ""));
        if (q.dueBy)
          rows = rows.filter((r) => typeof r.dueDate === "string" && r.dueDate <= (q.dueBy ?? ""));
        if (q.assigneeId)
          rows = rows.filter((r) =>
            ((r.assigneeIds as string[] | undefined) ?? []).includes(q.assigneeId ?? ""),
          );
        if (q.effort) rows = rows.filter((r) => (r.effort ?? "standard") === q.effort);
        if (q.updatedSince)
          rows = rows.filter((r) => String(r.updatedAt) >= (q.updatedSince ?? ""));
        if (q.handoff) {
          rows = rows.filter(
            (r) =>
              (r.tags as string[] | undefined)?.includes(HANDOFF_TAG) &&
              (q.handoff === "any" || r.acknowledged === undefined),
          );
        }
        if (q.path !== undefined) rows = rows.filter((r) => r.path === q.path);
        const order = byRankThenId(e);
        rows.sort(q.newestFirst ? (a, b) => order(b, a) : order);
        if (q.after !== undefined) {
          // The cursor is found among all the project's rows, so a filtered-out one still marks
          // the place; an unknown one is an error, as in SQL.
          const cursor = table(e).get(q.after);
          if (!cursor || (cursor.projectId ?? cursor.id) !== projectId) {
            throw new SatiError("NOT_FOUND", `No ${e} with id ${q.after}.`);
          }
          rows = rows.filter((r) => (q.newestFirst ? order(r, cursor) < 0 : order(r, cursor) > 0));
        }
        const start = q.offset ?? 0;
        return rows.slice(start, start + clampLimit(q.limit)).map(clone) as never;
      },
      readyTasks: async (projectId, now, limit, after) => {
        const tasks = live("task", projectId) as unknown as Task[];
        const cursor = after === undefined ? undefined : table("task").get(after);
        if (after !== undefined && (!cursor || cursor.projectId !== projectId)) {
          throw new SatiError("NOT_FOUND", `No task with id ${after}.`);
        }
        const order = byRankThenId("task");
        // Like the SQL store: a deleted dependency counts as out of the way.
        const status = (id: string) => {
          const dep = table("task").get(id) as Task | undefined;
          return dep?.deletedAt ? "done" : dep?.status;
        };
        return tasks
          .filter((t) => ready(t, status, now))
          .filter((t) => !cursor || order(t as never, cursor) > 0)
          .sort(order as never)
          .slice(0, clampLimit(limit))
          .map(clone);
      },
      // Deleted records keep their key, as the SQL unique index does.
      getByKey: async (e, projectId, key) =>
        clone(
          [...table(e).values()].find(
            (r) => (r.projectId ?? r.id) === projectId && keyOf(e, r) === key,
          ),
        ) as never,
      search: async (projectId, query, opts = {}) => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits: SearchHit[] = [];
        const test = opts.match === "any" ? "some" : "every";
        for (const entity of opts.entities ?? SEARCHABLE) {
          for (const r of live(entity, projectId)) {
            const text = JSON.stringify(r).toLowerCase();
            if (terms.length && terms[test]((t) => text.includes(t))) {
              const title = String(entity === "context" ? r.path : r.title);
              hits.push({ entity, id: r.id, title, snippet: "", rank: 0 });
            }
          }
        }
        return hits.slice(0, clampLimit(opts.limit));
      },
      listActivity: async (projectId, q = {}) => {
        const start = q.after === undefined ? 0 : s.activity.findIndex((a) => a.id === q.after);
        if (start < 0) throw new SatiError("NOT_FOUND", `No activity with id ${q.after}.`);
        const rows = s.activity
          .slice(q.after === undefined ? 0 : start + 1)
          .filter((a) => a.projectId === projectId)
          .filter((a) => (q.actorId ? a.actorId === q.actorId : true))
          .filter((a) => (q.entityId ? a.entityId === q.entityId : true))
          .filter((a) => (q.since ? a.at >= q.since : true));
        // Without a cursor, newest `at` first (then id), as SQL orders it; with one, commit order.
        const newest = (a: Activity, b: Activity) =>
          a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1;
        return (q.after === undefined ? rows.sort(newest) : rows)
          .slice(0, clampLimit(q.limit))
          .map(clone);
      },
      getActivity: async (id) => clone(s.activity.find((a) => a.id === id)),
      insert: async (e, rec) => {
        if (table(e).has(rec.id)) throw new SatiError("CONFLICT", `duplicate ${rec.id}`);
        uniqueKey(e, rec as AnyRecord);
        table(e).set(rec.id, clone(rec) as AnyRecord);
      },
      update: async (e, rec, expected) => {
        if (table(e).get(rec.id)?.version !== expected) {
          throw new SatiError("CONFLICT", `stale ${rec.id}`);
        }
        uniqueKey(e, rec as AnyRecord);
        table(e).set(rec.id, clone(rec) as AnyRecord);
      },
      appendActivity: async (a) => {
        s.activity.push(clone(a));
      },
    };
  }
}
