import { z } from "zod";
import { FEATURE_STATUSES, MILESTONE_STATUSES, TASK_STATUSES } from "./status.js";

/** Limits from the Security section: bodies up to 100 KB, arrays up to 500 items. */
export const LIMITS = {
  body: 100_000,
  title: 300,
  shortText: 2_000,
  array: 500,
  path: 1_000,
} as const;

export const SNAPSHOT_SCHEMA_VERSION = 1;

const ts = z.iso.datetime({ offset: false });
const title = z.string().trim().min(1).max(LIMITS.title);
const body = z.string().max(LIMITS.body);
const shortText = z.string().max(LIMITS.shortText);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(LIMITS.array);
const pathGlob = z.string().min(1).max(LIMITS.path);
const label = z.string().trim().min(1).max(100);

export const idOf = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `expected a ${prefix}_ id`);

export const ProjectId = idOf("prj");
export const ActorId = idOf("actr");
export const MilestoneId = idOf("mil");
export const FeatureId = idOf("feat");
export const TaskId = idOf("tsk");
export const DecisionId = idOf("dec");
export const NoteId = idOf("note");

const base = {
  projectId: ProjectId,
  createdAt: ts,
  updatedAt: ts,
  createdBy: ActorId,
  version: z.number().int().min(1),
  deletedAt: ts.nullable(),
};

export const MODES = ["git", "stealth", "standalone"] as const;
export const Mode = z.enum(MODES);
export type Mode = z.infer<typeof Mode>;

export const ProjectSettings = z.strictObject({
  leaseMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const Project = z.strictObject({
  id: ProjectId,
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name: title,
  repoUrl: z.string().max(LIMITS.path).nullable(),
  mode: Mode,
  settings: ProjectSettings,
  createdAt: ts,
  updatedAt: ts,
  createdBy: ActorId,
  version: z.number().int().min(1),
  deletedAt: ts.nullable(),
});
export type Project = z.infer<typeof Project>;

export const Milestone = z.strictObject({
  id: MilestoneId,
  ...base,
  title,
  goal: shortText,
  targetDate: z.iso.date().nullable(),
  status: z.enum(MILESTONE_STATUSES),
  order: z.number().int(),
});
export type Milestone = z.infer<typeof Milestone>;

export const Feature = z.strictObject({
  id: FeatureId,
  ...base,
  title,
  description: body,
  status: z.enum(FEATURE_STATUSES),
  protected: z.boolean(),
  paths: list(pathGlob),
  tests: list(pathGlob),
  acceptance: list(shortText),
  milestoneId: MilestoneId.nullable(),
});
export type Feature = z.infer<typeof Feature>;

export const Claim = z.strictObject({
  actorId: ActorId,
  leaseUntil: ts,
  heartbeatAt: ts,
});
export type Claim = z.infer<typeof Claim>;

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

export const Completion = z.strictObject({
  summary: z.string().trim().min(1).max(LIMITS.shortText),
  filesTouched: list(pathGlob).min(1),
  completedAt: ts,
  completedBy: ActorId,
});
export type Completion = z.infer<typeof Completion>;

export const Task = z
  .strictObject({
    id: TaskId,
    ...base,
    title,
    body,
    status: z.enum(TASK_STATUSES),
    priority: Priority,
    featureId: FeatureId.nullable(),
    parentId: TaskId.nullable(),
    dependsOn: list(TaskId),
    labels: list(label),
    branch: z.string().max(LIMITS.path).nullable(),
    worktree: z.string().max(LIMITS.path).nullable(),
    claim: Claim.nullable(),
    completion: Completion.nullable(),
  })
  .refine((t) => t.status !== "done" || t.completion !== null, {
    message: "a done task needs a completion summary and files touched",
    path: ["completion"],
  });
export type Task = z.infer<typeof Task>;

export const LOCK_MODES = ["exclusive", "shared"] as const;
export const Lock = z.strictObject({
  id: idOf("lck"),
  ...base,
  paths: list(pathGlob).min(1),
  actorId: ActorId,
  taskId: TaskId.nullable(),
  reason: shortText,
  leaseUntil: ts,
  mode: z.enum(LOCK_MODES),
});
export type Lock = z.infer<typeof Lock>;

export const Decision = z.strictObject({
  id: DecisionId,
  ...base,
  title,
  context: body,
  decision: body,
  consequences: body,
  supersedes: DecisionId.nullable(),
  featureIds: list(FeatureId),
});
export type Decision = z.infer<typeof Decision>;

export const Note = z.strictObject({
  id: NoteId,
  ...base,
  title,
  body,
  tags: list(label),
  links: list(z.string().max(LIMITS.path)),
  pinned: z.boolean(),
});
export type Note = z.infer<typeof Note>;

export const ContextEntry = z.strictObject({
  id: idOf("ctx"),
  ...base,
  path: pathGlob,
  summary: shortText,
  keyFiles: list(pathGlob),
  contentHash: z.string().max(200),
  gitCommit: z.string().max(64).nullable(),
});
export type ContextEntry = z.infer<typeof ContextEntry>;

export const ACTOR_KINDS = ["agent", "human"] as const;
export const Actor = z.strictObject({
  id: ActorId,
  projectId: ProjectId,
  kind: z.enum(ACTOR_KINDS),
  /** Stable identity string, e.g. `claude-code@feature-a#1234` or `$BRAIN_ACTOR`. */
  name: z.string().min(1).max(200),
  tool: z.string().max(100).nullable(),
  worktree: z.string().max(LIMITS.path).nullable(),
  createdAt: ts,
  updatedAt: ts,
  version: z.number().int().min(1),
  deletedAt: ts.nullable(),
});
export type Actor = z.infer<typeof Actor>;

export const VERBS = [
  "create",
  "update",
  "delete",
  "complete",
  "status",
  "import",
  "init",
] as const;
export const Activity = z.strictObject({
  id: idOf("act"),
  projectId: ProjectId,
  actorId: ActorId,
  verb: z.enum(VERBS),
  entity: z.string().max(40),
  entityId: z.string().max(60),
  diff: z.record(z.string(), z.unknown()),
  branch: z.string().max(LIMITS.path).nullable(),
  at: ts,
});
export type Activity = z.infer<typeof Activity>;

export interface EntityMap {
  project: Project;
  milestone: Milestone;
  feature: Feature;
  task: Task;
  lock: Lock;
  decision: Decision;
  note: Note;
  context: ContextEntry;
  actor: Actor;
}
export type StoredEntity = keyof EntityMap;

export const ENTITY_SCHEMAS: { [K in StoredEntity]: z.ZodType<EntityMap[K]> } = {
  project: Project,
  milestone: Milestone,
  feature: Feature,
  task: Task,
  lock: Lock,
  decision: Decision,
  note: Note,
  context: ContextEntry,
  actor: Actor,
};

/** `.brain/brain.config.json`: tells every worktree which project and mode it belongs to. */
export const BrainConfigSchema = z.strictObject({
  version: z.literal(1),
  projectId: ProjectId,
  mode: Mode,
});
export type BrainConfig = z.infer<typeof BrainConfigSchema>;
export const CONFIG_DIR = ".brain";
export const CONFIG_FILE = "brain.config.json";
