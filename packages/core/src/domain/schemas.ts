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

/**
 * A UTC timestamp, stored with exactly millisecond precision. Leases and claims are compared as
 * strings (in SQL too), which is only correct when every value has the same shape, so an
 * imported `…T00:00:00Z` or `…T00:00:00.123456Z` is rewritten to `…T00:00:00.000Z`.
 */
const ts = z.iso.datetime({ offset: false }).transform((v) => new Date(v).toISOString());
const title = z.string().trim().min(1).max(LIMITS.title);
const body = z.string().max(LIMITS.body);
const shortText = z.string().max(LIMITS.shortText);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(LIMITS.array);
const pathGlob = z.string().min(1).max(LIMITS.path);
const label = z.string().trim().min(1).max(100);
/**
 * A calendar day, YYYY-MM-DD. Not `z.iso.date()`: its leap-year regex is 330 characters in the
 * JSON Schema every agent loads with the tools; the short pattern plus this check is the same rule.
 */
export const IsoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, "use YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, "not a real day");

export const idOf = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `expected a ${prefix}_ id`);

export const ProjectId = idOf("prj");
export const ActorId = idOf("actr");
export const MilestoneId = idOf("mil");
export const FeatureId = idOf("feat");
export const TaskId = idOf("tsk");
export const DecisionId = idOf("dec");
export const NoteId = idOf("note");

/** Per-field hybrid logical clock stamp (`wall#counter#node`). Absent on records written before stamps. */
const hlcStamp = z.string().min(1).max(80);

const base = {
  projectId: ProjectId,
  createdAt: ts,
  updatedAt: ts,
  createdBy: ActorId,
  version: z.number().int().min(1),
  deletedAt: ts.nullable(),
  /** Set by the git merge driver when a field could not merge cleanly; absent otherwise. */
  needsReview: z.literal(true).optional(),
  /** Which write last set each field. The merge driver orders fields by these, not by `updatedAt`. */
  stamps: z.record(z.string().max(80), hlcStamp).optional(),
};

export const MODES = ["git", "stealth", "standalone"] as const;
export const Mode = z.enum(MODES);
export type Mode = z.infer<typeof Mode>;

export const REVIEW_MODES = ["agents", "all", "none"] as const;
export const ReviewMode = z.enum(REVIEW_MODES);
export type ReviewMode = z.infer<typeof ReviewMode>;

/** `code` projects track features, file reservations and the guard; `general` ones are plans, todos and notes only. */
export const PROJECT_KINDS = ["code", "general"] as const;
export const ProjectKind = z.enum(PROJECT_KINDS);
export type ProjectKind = z.infer<typeof ProjectKind>;

export const ProjectSettings = z.strictObject({
  leaseMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** Who must wait in `review` after task_complete. Default: agents. */
  review: ReviewMode.default("agents"),
  /** When on, the Stop nudge tells an idle agent to run `sati next`. Default off. */
  autoContinue: z.boolean().default(false),
  /** Written only for `general`, so existing projects and their `.sati/` files stay unchanged. */
  kind: ProjectKind.optional(),
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
  targetDate: IsoDay.nullable(),
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
  /**
   * Fencing token: the task version the claim was written at, so every claim gets a new one and
   * an old one never matches again. Writes on a claimed task must present it. Claims stored
   * before tokens existed have none.
   */
  token: z.number().int().positive().optional(),
});
export type Claim = z.infer<typeof Claim>;

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

export const Completion = z.strictObject({
  summary: z.string().trim().min(1).max(LIMITS.shortText),
  /** At least one in a code project (checked by `completeTask`); a general one may touch none. */
  filesTouched: list(pathGlob),
  completedAt: ts,
  completedBy: ActorId,
});
export type Completion = z.infer<typeof Completion>;

/** One step inside a task, ticked off in place. */
export const ChecklistItem = z.strictObject({
  text: z.string().trim().min(1).max(LIMITS.title),
  done: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItem>;

/** Task fields without the cross-field rule, so input schemas can `pick` from it. */
export const TaskShape = z.strictObject({
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
  /** Why a reviewer sent the task back to todo. The next claimer sees it in the brief. */
  reviewNote: shortText.nullable().optional(),
  /*
   * The planning fields are optional and written only once set, so records and `.sati/` files
   * from before them stay valid, and only tasks that use them carry the new keys.
   */
  /** The calendar day it is due (no time or zone: "by Friday"). */
  dueDate: IsoDay.nullable().optional(),
  /** Who should do it, people or agents. The claim says who is doing it right now. */
  assigneeIds: list(ActorId).optional(),
  checklist: z.array(ChecklistItem).max(100).optional(),
  /** The plan it belongs to, for tasks without a feature (a general project has none). */
  milestoneId: MilestoneId.nullable().optional(),
});

export const Task = TaskShape.refine((t) => t.status !== "done" || t.completion !== null, {
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
/** Avatar colours a person can pick. Named, not hex, so every one keeps contrast in both themes. */
export const ACTOR_COLORS = [
  "moss",
  "teal",
  "sky",
  "plum",
  "rose",
  "clay",
  "sun",
  "slate",
] as const;
export const Actor = z.strictObject({
  id: ActorId,
  projectId: ProjectId,
  kind: z.enum(ACTOR_KINDS),
  /** Stable identity string, e.g. `claude-code@feature-a#1234` or `$SATI_ACTOR`. */
  name: z.string().min(1).max(200),
  tool: z.string().max(100).nullable(),
  worktree: z.string().max(LIMITS.path).nullable(),
  /*
   * How a person is shown. `name` stays the stable identity sati looks actors up by; these are
   * only what people read, and are absent until set.
   */
  displayName: z.string().trim().min(1).max(80).optional(),
  /** Up to three letters for the avatar; Khmer clusters take more code units, hence 8. */
  initials: z.string().trim().min(1).max(8).optional(),
  color: z.enum(ACTOR_COLORS).optional(),
  createdAt: ts,
  updatedAt: ts,
  version: z.number().int().min(1),
  deletedAt: ts.nullable(),
  /**
   * Latest hybrid logical clock stamp this actor has issued or observed.
   * Kept so a process with a slow wall clock still stamps new writes after ones it has seen.
   */
  lastHlc: hlcStamp.nullable().optional(),
});
export type Actor = z.infer<typeof Actor>;

export const VERBS = [
  "create",
  "update",
  "delete",
  "complete",
  "claim",
  "release",
  "status",
  "import",
  "init",
  "guard",
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

/** `.sati/sati.config.json`: tells every worktree which project and mode it belongs to. */
export const SatiConfigSchema = z.strictObject({
  version: z.literal(1),
  projectId: ProjectId,
  mode: Mode,
  /** Present only for `general`, so every clone sets up the project the same way. */
  kind: ProjectKind.optional(),
  guard: z
    .strictObject({
      /** Share of a protected feature's changed lines a commit may remove before it is blocked. */
      maxRemovalRatio: z.number().min(0).max(1).optional(),
    })
    .optional(),
});
export type SatiConfig = z.infer<typeof SatiConfigSchema>;
export const CONFIG_DIR = ".sati";
export const CONFIG_FILE = "sati.config.json";
