import type { Activity, EntityMap, Project, StoredEntity, Task } from "../domain/schemas.js";

export interface ListQuery {
  status?: readonly string[] | undefined;
  featureId?: string | undefined;
  milestoneId?: string | undefined;
  /** Tasks in a milestone: their own `milestoneId` is it, or their feature is one of `featureIds`. */
  inMilestone?: { milestoneId: string; featureIds: readonly string[] } | undefined;
  parentId?: string | undefined;
  label?: string | undefined;
  /** Tasks due on or before this ISO date. */
  dueBy?: string | undefined;
  /** Tasks with this actor in `assigneeIds`. */
  assigneeId?: string | undefined;
  /** Records changed at or after this UTC time (`updatedAt`, which every write moves). */
  updatedSince?: string | undefined;
  includeDeleted?: boolean | undefined;
  /** Reverse the usual order (rank, then id); with equal ranks this means newest first. */
  newestFirst?: boolean | undefined;
  /** Default 50, max 500. */
  limit?: number | undefined;
  offset?: number | undefined;
}

/** `context` is a card: its path is the hit's title. */
export const SEARCHABLE = ["task", "feature", "note", "decision", "context"] as const;
export type SearchableEntity = (typeof SEARCHABLE)[number];

export interface SearchHit {
  entity: SearchableEntity;
  id: string;
  title: string;
  snippet: string;
  /** BM25 rank; lower is better. */
  rank: number;
}

export interface SearchOptions {
  entities?: readonly SearchableEntity[] | undefined;
  limit?: number | undefined;
  /** `all` = every term must match (default); `any` = at least one term. */
  match?: "all" | "any" | undefined;
}

export interface ActivityQuery {
  entityId?: string | undefined;
  actorId?: string | undefined;
  /** Inclusive lower bound on `at` (UTC ISO). */
  since?: string | undefined;
  /**
   * Cursor: only rows written after the row with this id, oldest first, in the order the writes
   * committed (not by id or clock, which can disagree across processes). NOT_FOUND if unknown.
   */
  after?: string | undefined;
  limit?: number | undefined;
}

/** Read access. All methods see one consistent snapshot when used inside `read`/`write`. */
export interface StorageReader {
  getProject(): Promise<Project | undefined>;
  get<E extends StoredEntity>(entity: E, id: string): Promise<EntityMap[E] | undefined>;
  /** Records whose id ends with `suffix` (case-insensitive), for short handles. */
  findBySuffix<E extends StoredEntity>(entity: E, suffix: string): Promise<EntityMap[E][]>;
  list<E extends StoredEntity>(
    entity: E,
    projectId: string,
    query?: ListQuery,
  ): Promise<EntityMap[E][]>;
  /** Tasks that are todo, not actively claimed at `now`, and whose dependencies are all done. */
  readyTasks(projectId: string, now: string, limit: number): Promise<Task[]>;
  /** Looks up an entity by its unique `key` (actor name, project slug). */
  getByKey<E extends StoredEntity>(
    entity: E,
    projectId: string,
    key: string,
  ): Promise<EntityMap[E] | undefined>;
  search(projectId: string, query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  listActivity(projectId: string, query?: ActivityQuery): Promise<Activity[]>;
  getActivity(id: string): Promise<Activity | undefined>;
}

export interface StorageWriter extends StorageReader {
  insert<E extends StoredEntity>(entity: E, record: EntityMap[E]): Promise<void>;
  /** Replaces the record if its stored version equals `expectedVersion`; otherwise throws CONFLICT. */
  update<E extends StoredEntity>(
    entity: E,
    record: EntityMap[E],
    expectedVersion: number,
  ): Promise<void>;
  appendActivity(activity: Activity): Promise<void>;
}

export interface StorageAdapter {
  /** Runs `fn` against a consistent view. */
  read<T>(fn: (r: StorageReader) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in one write transaction. Writers across processes queue rather than fail.
   * If `fn` throws, nothing is written.
   */
  write<T>(fn: (w: StorageWriter) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
