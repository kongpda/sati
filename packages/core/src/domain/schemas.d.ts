import { z } from "zod";
/** Limits from the Security section: bodies up to 100 KB, arrays up to 500 items. */
export declare const LIMITS: {
    /** Bytes of UTF-8, not characters: 100,000 Khmer characters would be about 300 KB. */
    readonly body: 100000;
    /** Bytes of UTF-8 across one write's batch, such as all of a task's `subtasks[]`. */
    readonly batch: 1000000;
    readonly title: 300;
    readonly shortText: 2000;
    readonly array: 500;
    readonly path: 1000;
    readonly waitingText: 500;
};
/** UTF-8 length without allocating: 1 byte for ASCII, 2 to 3 per other unit, 4 per pair. */
export declare function utf8Bytes(text: string): number;
/**
 * Markdown text up to 100 KB. The character cap is checked first so a huge string is refused
 * before it is measured; UTF-8 is never shorter than its character count.
 */
export declare const BodyText: z.ZodString;
/**
 * A calendar day, YYYY-MM-DD. Not `z.iso.date()`: its leap-year regex is 330 characters in the
 * JSON Schema every agent loads with the tools; the short pattern plus this check is the same rule.
 */
export declare const IsoDay: z.ZodString;
export declare const idOf: (prefix: string) => z.ZodString;
export declare const ProjectId: z.ZodString;
export declare const ActorId: z.ZodString;
export declare const MilestoneId: z.ZodString;
export declare const FeatureId: z.ZodString;
export declare const TaskId: z.ZodString;
export declare const DecisionId: z.ZodString;
export declare const NoteId: z.ZodString;
/**
 * `JSON.stringify` replacer for what agents and scripts read: drops the per-field `stamps`, which
 * only the merge driver uses and which can be half the size of a record.
 */
export declare const withoutStamps: (key: string, value: unknown) => unknown;
export declare const MODES: readonly ["git", "stealth", "standalone"];
export declare const Mode: z.ZodEnum<{
    git: "git";
    standalone: "standalone";
    stealth: "stealth";
}>;
export type Mode = z.infer<typeof Mode>;
export declare const REVIEW_MODES: readonly ["agents", "all", "none"];
export declare const ReviewMode: z.ZodEnum<{
    agents: "agents";
    all: "all";
    none: "none";
}>;
export type ReviewMode = z.infer<typeof ReviewMode>;
/** `code` projects track features, file reservations and the guard; `general` ones are plans, todos and notes only. */
export declare const PROJECT_KINDS: readonly ["code", "general"];
export declare const ProjectKind: z.ZodEnum<{
    code: "code";
    general: "general";
}>;
export type ProjectKind = z.infer<typeof ProjectKind>;
export declare const ProjectSettings: z.ZodObject<{
    leaseMinutes: z.ZodNumber;
    review: z.ZodDefault<z.ZodEnum<{
        agents: "agents";
        all: "all";
        none: "none";
    }>>;
    autoContinue: z.ZodDefault<z.ZodBoolean>;
    kind: z.ZodOptional<z.ZodEnum<{
        code: "code";
        general: "general";
    }>>;
}, z.core.$strict>;
export type ProjectSettings = z.infer<typeof ProjectSettings>;
export declare const Project: z.ZodObject<{
    id: z.ZodString;
    slug: z.ZodString;
    name: z.ZodString;
    repoUrl: z.ZodNullable<z.ZodString>;
    mode: z.ZodEnum<{
        git: "git";
        standalone: "standalone";
        stealth: "stealth";
    }>;
    settings: z.ZodObject<{
        leaseMinutes: z.ZodNumber;
        review: z.ZodDefault<z.ZodEnum<{
            agents: "agents";
            all: "all";
            none: "none";
        }>>;
        autoContinue: z.ZodDefault<z.ZodBoolean>;
        kind: z.ZodOptional<z.ZodEnum<{
            code: "code";
            general: "general";
        }>>;
    }, z.core.$strict>;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
}, z.core.$strict>;
export type Project = z.infer<typeof Project>;
export declare const Milestone: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    title: z.ZodString;
    goal: z.ZodString;
    targetDate: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<{
        active: "active";
        done: "done";
        planned: "planned";
    }>;
    order: z.ZodNumber;
}, z.core.$strict>;
export type Milestone = z.infer<typeof Milestone>;
export declare const Feature: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    title: z.ZodString;
    description: z.ZodString;
    status: z.ZodEnum<{
        building: "building";
        deprecated: "deprecated";
        planned: "planned";
        removed: "removed";
        shipped: "shipped";
    }>;
    protected: z.ZodBoolean;
    paths: z.ZodArray<z.ZodString>;
    tests: z.ZodArray<z.ZodString>;
    acceptance: z.ZodArray<z.ZodString>;
    milestoneId: z.ZodNullable<z.ZodString>;
}, z.core.$strict>;
export type Feature = z.infer<typeof Feature>;
/** Why a claim's holder waits on a person: it asked a question, or its tool needs a permission. */
export declare const WAITING_KINDS: readonly ["question", "permission"];
/** A full git commit id (SHA-1 or SHA-256). */
export declare const CommitSha: z.ZodString;
export declare const Claim: z.ZodObject<{
    actorId: z.ZodString;
    leaseUntil: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    heartbeatAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    token: z.ZodOptional<z.ZodNumber>;
    waiting: z.ZodOptional<z.ZodObject<{
        kind: z.ZodEnum<{
            permission: "permission";
            question: "question";
        }>;
        text: z.ZodString;
        since: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    }, z.core.$strict>>;
    holder: z.ZodOptional<z.ZodObject<{
        host: z.ZodString;
        pid: z.ZodNumber;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Claim = z.infer<typeof Claim>;
export declare const PRIORITIES: readonly ["low", "medium", "high", "urgent"];
export declare const Priority: z.ZodEnum<{
    high: "high";
    low: "low";
    medium: "medium";
    urgent: "urgent";
}>;
export type Priority = z.infer<typeof Priority>;
/**
 * How much thinking a task needs, so an agent can pick a model for it: `light` work (a rename,
 * a typo, a one-file edit) can go to a subagent on a small model. Unset means `standard`.
 */
export declare const EFFORTS: readonly ["light", "standard", "deep"];
export declare const Effort: z.ZodEnum<{
    deep: "deep";
    light: "light";
    standard: "standard";
}>;
export type Effort = z.infer<typeof Effort>;
export declare const Completion: z.ZodObject<{
    summary: z.ZodString;
    releaseNote: z.ZodOptional<z.ZodString>;
    filesTouched: z.ZodArray<z.ZodString>;
    completedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    completedBy: z.ZodString;
    commit: z.ZodOptional<z.ZodString>;
    branch: z.ZodOptional<z.ZodString>;
    approvedCommit: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type Completion = z.infer<typeof Completion>;
/** One step inside a task, ticked off in place. */
export declare const ChecklistItem: z.ZodObject<{
    text: z.ZodString;
    done: z.ZodBoolean;
}, z.core.$strict>;
export type ChecklistItem = z.infer<typeof ChecklistItem>;
/** Task fields without the cross-field rule, so input schemas can `pick` from it. */
export declare const TaskShape: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    status: z.ZodEnum<{
        backlog: "backlog";
        blocked: "blocked";
        cancelled: "cancelled";
        done: "done";
        in_progress: "in_progress";
        review: "review";
        todo: "todo";
    }>;
    priority: z.ZodEnum<{
        high: "high";
        low: "low";
        medium: "medium";
        urgent: "urgent";
    }>;
    featureId: z.ZodNullable<z.ZodString>;
    parentId: z.ZodNullable<z.ZodString>;
    dependsOn: z.ZodArray<z.ZodString>;
    labels: z.ZodArray<z.ZodString>;
    branch: z.ZodNullable<z.ZodString>;
    worktree: z.ZodNullable<z.ZodString>;
    claim: z.ZodNullable<z.ZodObject<{
        actorId: z.ZodString;
        leaseUntil: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        heartbeatAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        token: z.ZodOptional<z.ZodNumber>;
        waiting: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                permission: "permission";
                question: "question";
            }>;
            text: z.ZodString;
            since: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        }, z.core.$strict>>;
        holder: z.ZodOptional<z.ZodObject<{
            host: z.ZodString;
            pid: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    completion: z.ZodNullable<z.ZodObject<{
        summary: z.ZodString;
        releaseNote: z.ZodOptional<z.ZodString>;
        filesTouched: z.ZodArray<z.ZodString>;
        completedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        completedBy: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        approvedCommit: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    reviewNote: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    blockedReason: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dueDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    assigneeIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    checklist: z.ZodOptional<z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        done: z.ZodBoolean;
    }, z.core.$strict>>>;
    milestoneId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    effort: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        deep: "deep";
        light: "light";
        standard: "standard";
    }>>>;
}, z.core.$strict>;
export declare const Task: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    status: z.ZodEnum<{
        backlog: "backlog";
        blocked: "blocked";
        cancelled: "cancelled";
        done: "done";
        in_progress: "in_progress";
        review: "review";
        todo: "todo";
    }>;
    priority: z.ZodEnum<{
        high: "high";
        low: "low";
        medium: "medium";
        urgent: "urgent";
    }>;
    featureId: z.ZodNullable<z.ZodString>;
    parentId: z.ZodNullable<z.ZodString>;
    dependsOn: z.ZodArray<z.ZodString>;
    labels: z.ZodArray<z.ZodString>;
    branch: z.ZodNullable<z.ZodString>;
    worktree: z.ZodNullable<z.ZodString>;
    claim: z.ZodNullable<z.ZodObject<{
        actorId: z.ZodString;
        leaseUntil: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        heartbeatAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        token: z.ZodOptional<z.ZodNumber>;
        waiting: z.ZodOptional<z.ZodObject<{
            kind: z.ZodEnum<{
                permission: "permission";
                question: "question";
            }>;
            text: z.ZodString;
            since: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        }, z.core.$strict>>;
        holder: z.ZodOptional<z.ZodObject<{
            host: z.ZodString;
            pid: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    completion: z.ZodNullable<z.ZodObject<{
        summary: z.ZodString;
        releaseNote: z.ZodOptional<z.ZodString>;
        filesTouched: z.ZodArray<z.ZodString>;
        completedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
        completedBy: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
        branch: z.ZodOptional<z.ZodString>;
        approvedCommit: z.ZodOptional<z.ZodString>;
    }, z.core.$strict>>;
    reviewNote: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    blockedReason: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dueDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    assigneeIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    checklist: z.ZodOptional<z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        done: z.ZodBoolean;
    }, z.core.$strict>>>;
    milestoneId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    effort: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        deep: "deep";
        light: "light";
        standard: "standard";
    }>>>;
}, z.core.$strict>;
export type Task = z.infer<typeof Task>;
export declare const LOCK_MODES: readonly ["exclusive", "shared"];
export declare const Lock: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    paths: z.ZodArray<z.ZodString>;
    actorId: z.ZodString;
    taskId: z.ZodNullable<z.ZodString>;
    reason: z.ZodString;
    leaseUntil: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    mode: z.ZodEnum<{
        exclusive: "exclusive";
        shared: "shared";
    }>;
}, z.core.$strict>;
export type Lock = z.infer<typeof Lock>;
export declare const Decision: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    title: z.ZodString;
    context: z.ZodString;
    decision: z.ZodString;
    consequences: z.ZodString;
    supersedes: z.ZodNullable<z.ZodString>;
    featureIds: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type Decision = z.infer<typeof Decision>;
export declare const Note: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    title: z.ZodString;
    body: z.ZodString;
    tags: z.ZodArray<z.ZodString>;
    links: z.ZodArray<z.ZodString>;
    pinned: z.ZodBoolean;
    private: z.ZodOptional<z.ZodLiteral<true>>;
    handoffTo: z.ZodOptional<z.ZodString>;
    handoffToName: z.ZodOptional<z.ZodString>;
    handoffFromName: z.ZodOptional<z.ZodString>;
    acknowledged: z.ZodOptional<z.ZodObject<{
        by: z.ZodString;
        at: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Note = z.infer<typeof Note>;
/** A card holds up to 50 facts of 300 characters: enough to answer from, small enough to recall. */
export declare const MAX_FACTS = 50;
export declare const FACT_CHARS = 300;
export declare const ContextEntry: z.ZodObject<{
    projectId: z.ZodString;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    createdBy: z.ZodString;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    needsReview: z.ZodOptional<z.ZodLiteral<true>>;
    stamps: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    id: z.ZodString;
    path: z.ZodString;
    summary: z.ZodString;
    keyFiles: z.ZodArray<z.ZodString>;
    contentHash: z.ZodString;
    gitCommit: z.ZodNullable<z.ZodString>;
    facts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sourceSeen: z.ZodOptional<z.ZodString>;
    sourceTokens: z.ZodOptional<z.ZodNumber>;
    private: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strict>;
export type ContextEntry = z.infer<typeof ContextEntry>;
export declare const ACTOR_KINDS: readonly ["agent", "human"];
/** Avatar colours a person can pick. Named, not hex, so every one keeps contrast in both themes. */
export declare const ACTOR_COLORS: readonly ["moss", "teal", "sky", "plum", "rose", "clay", "sun", "slate"];
export declare const Actor: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    kind: z.ZodEnum<{
        agent: "agent";
        human: "human";
    }>;
    name: z.ZodString;
    tool: z.ZodNullable<z.ZodString>;
    worktree: z.ZodNullable<z.ZodString>;
    displayName: z.ZodOptional<z.ZodString>;
    initials: z.ZodOptional<z.ZodString>;
    color: z.ZodOptional<z.ZodEnum<{
        clay: "clay";
        moss: "moss";
        plum: "plum";
        rose: "rose";
        sky: "sky";
        slate: "slate";
        sun: "sun";
        teal: "teal";
    }>>;
    createdAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    updatedAt: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
    version: z.ZodNumber;
    deletedAt: z.ZodNullable<z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>>;
    lastHlc: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type Actor = z.infer<typeof Actor>;
export declare const VERBS: readonly ["create", "update", "delete", "complete", "claim", "release", "status", "import", "init", "guard"];
export declare const Activity: z.ZodObject<{
    id: z.ZodString;
    projectId: z.ZodString;
    actorId: z.ZodString;
    verb: z.ZodEnum<{
        claim: "claim";
        complete: "complete";
        create: "create";
        delete: "delete";
        guard: "guard";
        import: "import";
        init: "init";
        release: "release";
        status: "status";
        update: "update";
    }>;
    entity: z.ZodString;
    entityId: z.ZodString;
    diff: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    branch: z.ZodNullable<z.ZodString>;
    at: z.ZodPipe<z.ZodISODateTime, z.ZodTransform<string, string>>;
}, z.core.$strict>;
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
export declare const ENTITY_SCHEMAS: {
    [K in StoredEntity]: z.ZodType<EntityMap[K]>;
};
/** `.sati/sati.config.json`: tells every worktree which project and mode it belongs to. */
export declare const SatiConfigSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    projectId: z.ZodString;
    mode: z.ZodEnum<{
        git: "git";
        standalone: "standalone";
        stealth: "stealth";
    }>;
    kind: z.ZodOptional<z.ZodEnum<{
        code: "code";
        general: "general";
    }>>;
    guard: z.ZodOptional<z.ZodObject<{
        maxRemovalRatio: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type SatiConfig = z.infer<typeof SatiConfigSchema>;
export declare const CONFIG_DIR = ".sati";
export declare const CONFIG_FILE = "sati.config.json";
