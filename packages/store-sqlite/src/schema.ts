import { sql } from "drizzle-orm";
import {
  type IndexBuilder,
  index,
  integer,
  type SQLiteColumn,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Every entity table has the same shape: the full validated record lives in `data`
 * (JSON), and the fields we filter or sort on are copied into indexed columns.
 * One generic shape keeps the adapter small; Zod is the source of truth for fields.
 */
const entityColumns = () => ({
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  key: text("key"),
  status: text("status"),
  featureId: text("feature_id"),
  milestoneId: text("milestone_id"),
  parentId: text("parent_id"),
  claimLeaseUntil: text("claim_lease_until"),
  rank: integer("rank").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
  version: integer("version").notNull(),
  data: text("data").notNull(),
});

type Cols = ReturnType<typeof entityColumns>;
type Extra = (t: { [K in keyof Cols]: SQLiteColumn }) => IndexBuilder[];

const entityTable = (name: string, extra: Extra = () => []) =>
  sqliteTable(name, entityColumns(), (t) => [
    // Lists sort by (rank, id); ending each index with both lets SQLite stop after `limit` rows.
    index(`${name}_project_status`).on(t.projectId, t.status, t.rank, t.id),
    index(`${name}_project_rank`).on(t.projectId, t.rank, t.id),
    index(`${name}_project_feature`).on(t.projectId, t.featureId),
    index(`${name}_project_updated`).on(t.projectId, t.updatedAt),
    uniqueIndex(`${name}_project_key`).on(t.projectId, t.key),
    ...extra(t),
  ]);

export const projects = entityTable("projects");
export const milestones = entityTable("milestones");
export const features = entityTable("features");
export const tasks = entityTable("tasks", (t) => [
  index("tasks_claim_lease").on(t.claimLeaseUntil),
  index("tasks_parent").on(t.parentId),
]);
export const locks = entityTable("locks", (t) => [
  // Released locks stay as tombstones. Lock checks run inside the write lock and read only live
  // rows, so these partial indexes skip the tombstones (review WP3.1).
  index("locks_live").on(t.projectId, t.rank, t.id).where(sql`${t.deletedAt} is null`),
  index("locks_live_task")
    .on(t.projectId, sql`json_extract(${t.data}, '$.taskId')`)
    .where(sql`${t.deletedAt} is null`),
]);
export const decisions = entityTable("decisions");
export const notes = entityTable("notes");
export const contextEntries = entityTable("context_entries");
export const actors = entityTable("actors");

export type EntityTable = typeof projects;

export const activity = sqliteTable(
  "activity",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    actorId: text("actor_id").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    at: text("at").notNull(),
    data: text("data").notNull(),
  },
  (t) => [
    index("activity_project_at").on(t.projectId, t.at),
    index("activity_entity").on(t.entityId, t.at),
    index("activity_actor").on(t.actorId, t.at),
  ],
);
