import { z } from "zod";
import { globBraceError, normalizeLockPath } from "./locks.js";
import { FEATURE_STATUSES, MILESTONE_STATUSES, TASK_STATUSES } from "./status.js";

/** Limits from the Security section: bodies up to 100 KB, arrays up to 500 items. */
export const LIMITS = {
  /** Bytes of UTF-8, not characters: 100,000 Khmer characters would be about 300 KB. */
  body: 100_000,
  /** Bytes of UTF-8 across one write's batch, such as all of a task's `subtasks[]`. */
  batch: 1_000_000,
  title: 300,
  shortText: 2_000,
  array: 500,
  path: 1_000,
  waitingText: 500,
} as const;

/**
 * A UTC timestamp, stored with exactly millisecond precision. Leases and claims are compared as
 * strings (in SQL too), which is only correct when every value has the same shape, so an
 * imported `…T00:00:00Z` or `…T00:00:00.123456Z` is rewritten to `…T00:00:00.000Z`.
 */
const ts = z.iso.datetime({ offset: false }).transform((v) => new Date(v).toISOString());
const title = z.string().trim().min(1).max(LIMITS.title);
/** UTF-8 length without allocating: 1 byte for ASCII, 2 to 3 per other unit, 4 per pair. */
export function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    n +=
      c < 0x80
        ? 1
        : c < 0x800
          ? 2
          : c >= 0xd800 && c <= 0xdbff
            ? 4
            : c >= 0xdc00 && c <= 0xdfff
              ? 0
              : 3;
  }
  return n;
}

/**
 * Markdown text up to 100 KB. The character cap is checked first so a huge string is refused
 * before it is measured; UTF-8 is never shorter than its character count.
 */
export const BodyText = z
  .string()
  .max(LIMITS.body)
  .refine((v) => utf8Bytes(v) <= LIMITS.body, "is over 100 KB");
/**
 * Stored text keeps the older character cap: records written before the byte cap (100,000 Khmer
 * characters is about 300 KB) must still import and stay editable. New text is checked in bytes
 * by the write inputs, which replace these fields with `BodyText`.
 */
const body = z.string().max(LIMITS.body);
const shortText = z.string().max(LIMITS.shortText);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(LIMITS.array);
const pathGlob = z.string().min(1).max(LIMITS.path);
const label = z.string().trim().min(1).max(100);
/**
 * A repo-relative path or glob from input, normalised (no `./`, no trailing `/`). Absolute paths
 * and `..` are refused: they never match a repo file, so the guard and reviews would miss them.
 */
export const RepoPath = z
  .string()
  .min(1)
  .max(LIMITS.path)
  .transform((raw, c) => {
    const tooMany = globBraceError(raw);
    if (tooMany) {
      c.addIssue({ code: "custom", message: tooMany });
      return z.NEVER;
    }
    const p = normalizeLockPath(raw);
    if (p === undefined) {
      c.addIssue({ code: "custom", message: `"${raw}" is not a repo-relative path or glob` });
      return z.NEVER;
    }
    return p;
  });

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

/**
 * `JSON.stringify` replacer for what agents and scripts read: drops the per-field `stamps`, which
 * only the merge driver uses and which can be half the size of a record.
 */
export const withoutStamps = (key: string, value: unknown): unknown =>
  key === "stamps" ? undefined : value;

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

/** Why a claim's holder waits on a person: it asked a question, or its tool needs a permission. */
export const WAITING_KINDS = ["question", "permission"] as const;

/** A full git commit id (SHA-1 or SHA-256). */
export const CommitSha = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "expected a commit id");

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
  /**
   * The holder is blocked on a person: a question it asked, or a permission prompt in its tool.
   * Cleared by the holder's next write, by the person's reply (a hook) or when the claim ends.
   */
  waiting: z
    .strictObject({
      kind: z.enum(WAITING_KINDS),
      text: z.string().trim().min(1).max(LIMITS.waitingText),
      since: ts,
    })
    .optional(),
  /**
   * The long-lived process that holds the claim (the agent's MCP server), so a claim whose
   * process has exited can be released before its lease runs out. Absent for CLI-only claims.
   */
  holder: z
    .strictObject({
      host: z.string().min(1).max(255),
      pid: z.number().int().positive(),
    })
    .optional(),
});
export type Claim = z.infer<typeof Claim>;

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export const Priority = z.enum(PRIORITIES);
export type Priority = z.infer<typeof Priority>;

/**
 * How much thinking a task needs, so an agent can pick a model for it: `light` work (a rename,
 * a typo, a one-file edit) can go to a subagent on a small model. Unset means `standard`.
 */
export const EFFORTS = ["light", "standard", "deep"] as const;
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;

export const Completion = z.strictObject({
  summary: z.string().trim().min(1).max(LIMITS.shortText),
  /**
   * One line for the people who use the product ("Export now includes due dates"), separate
   * from the summary written for developers. Changelogs use it, falling back to the summary.
   */
  releaseNote: z.string().trim().min(1).max(LIMITS.title).optional(),
  /** At least one in a code project (checked by `completeTask`); a general one may touch none. */
  filesTouched: list(pathGlob),
  completedAt: ts,
  completedBy: ActorId,
  /** The commit and branch the work was finished at, so a review sees what moved after it. */
  commit: CommitSha.optional(),
  branch: z.string().min(1).max(LIMITS.path).optional(),
  /** The commit a person approved: the branch head at approval, or `commit` if the branch is gone. */
  approvedCommit: CommitSha.optional(),
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
  /** Why the task is blocked. Set with the move to `blocked`, cleared when it leaves. */
  blockedReason: shortText.nullable().optional(),
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
  /** How much thinking it needs; unset is `standard`. See `EFFORTS`. */
  effort: Effort.nullable().optional(),
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
  /** Kept in this machine's database only: never exported to `.sati/` or synced. Absent when shared. */
  private: z.literal(true).optional(),
  /** A handoff addressed to one actor; without it the handoff is for whoever claims the task. */
  handoffTo: ActorId.optional(),
  /**
   * The addressee's actor name. Actors are not in the snapshot, so in a teammate's clone the id
   * above names no one; the name (\`kim@app\`, or \`$SATI_ACTOR\`) still finds the same person.
   */
  handoffToName: z.string().min(1).max(200).optional(),
  /** The author's actor name on a handoff, so a teammate's clone can say who left it. */
  handoffFromName: z.string().min(1).max(200).optional(),
  /** Who read and acknowledged the handoff, and when. Cleared when the handoff is rewritten. */
  acknowledged: z.strictObject({ by: ActorId, at: ts }).optional(),
});
export type Note = z.infer<typeof Note>;

/** A card holds up to 50 facts of 300 characters: enough to answer from, small enough to recall. */
export const MAX_FACTS = 50;
export const FACT_CHARS = 300;

export const ContextEntry = z.strictObject({
  id: idOf("ctx"),
  ...base,
  path: pathGlob,
  summary: shortText,
  keyFiles: list(pathGlob),
  contentHash: z.string().max(200),
  gitCommit: z.string().max(64).nullable(),
  /*
   * Memory of a file, written by the agent that read it; sati never opens the file. All optional
   * and written only once set, so entries and `.sati/` files from before them stay valid.
   */
  /** Short facts worth quoting: "Hall B quote: $2,400, valid until 1 December". */
  facts: z.array(z.string().trim().min(1).max(FACT_CHARS)).max(MAX_FACTS).optional(),
  tags: list(label).optional(),
  /** The file version the agent read (modified time or hash), so the next agent can compare. */
  sourceSeen: z.string().trim().min(1).max(200).optional(),
  /** The agent's estimate of what reading the file cost, in tokens. */
  sourceTokens: z.number().int().min(0).max(100_000_000).optional(),
  /** Kept in this machine's database only, like a private note. */
  private: z.literal(true).optional(),
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
