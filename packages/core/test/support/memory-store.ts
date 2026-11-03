import {
  type Activity,
  BrainError,
  type EntityMap,
  isReady,
  type Project,
  type SearchHit,
  type StorageAdapter,
  type StorageWriter,
  type StoredEntity,
  type Task,
} from "../../src/index.js";

interface State {
  records: Map<StoredEntity, Map<string, EntityMap[StoredEntity]>>;
  activity: Activity[];
}

type AnyRecord = EntityMap[StoredEntity] & Record<string, unknown>;

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
      const draft = structuredClone(this.state);
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
    return {
      getProject: async () => clone([...table("project").values()][0] as Project | undefined),
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
        if (q.label) rows = rows.filter((r) => (r.labels as string[]).includes(q.label ?? ""));
        if (q.newestFirst) rows = rows.reverse();
        const start = q.offset ?? 0;
        return rows.slice(start, start + (q.limit ?? 50)).map(clone) as never;
      },
      readyTasks: async (projectId, now, limit) => {
        const tasks = live("task", projectId) as unknown as Task[];
        const status = (id: string) => (table("task").get(id) as Task | undefined)?.status;
        return tasks
          .filter((t) => isReady(t, status, new Date(now)))
          .slice(0, limit)
          .map(clone);
      },
      getByKey: async (e, projectId, key) =>
        clone(live(e, projectId).find((r) => (e === "project" ? r.slug : r.name) === key)) as never,
      search: async (projectId, query, opts = {}) => {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits: SearchHit[] = [];
        const test = opts.match === "any" ? "some" : "every";
        for (const entity of opts.entities ?? (["task", "feature", "note", "decision"] as const)) {
          for (const r of live(entity, projectId)) {
            const text = JSON.stringify(r).toLowerCase();
            if (terms.length && terms[test]((t) => text.includes(t))) {
              hits.push({ entity, id: r.id, title: String(r.title), snippet: "", rank: 0 });
            }
          }
        }
        return hits;
      },
      listActivity: async (projectId) =>
        s.activity
          .filter((a) => a.projectId === projectId)
          .reverse()
          .map(clone),
      insert: async (e, rec) => {
        if (table(e).has(rec.id)) throw new BrainError("CONFLICT", `duplicate ${rec.id}`);
        table(e).set(rec.id, clone(rec) as AnyRecord);
      },
      update: async (e, rec, expected) => {
        if (table(e).get(rec.id)?.version !== expected) {
          throw new BrainError("CONFLICT", `stale ${rec.id}`);
        }
        table(e).set(rec.id, clone(rec) as AnyRecord);
      },
      appendActivity: async (a) => {
        s.activity.push(clone(a));
      },
    };
  }
}
