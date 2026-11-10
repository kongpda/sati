import { type ServiceContext } from "./context.js";
/**
 * Reverts one activity row when every field it changed still has the value that row wrote.
 * The revert is its own activity row. A later edit is CONFLICT.
 */
export declare function undoActivity(ctx: ServiceContext, activityId: string): Promise<{
    id: string;
    projectId: string;
    kind: "agent" | "human";
    name: string;
    tool: string | null;
    worktree: string | null;
    displayName?: string | undefined;
    initials?: string | undefined;
    color?: "clay" | "moss" | "plum" | "rose" | "sky" | "slate" | "sun" | "teal" | undefined;
    createdAt: string;
    updatedAt: string;
    version: number;
    deletedAt: string | null;
    lastHlc?: string | null | undefined;
} | {
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
    needsReview?: true | undefined;
    stamps?: Record<string, string> | undefined;
    id: string;
    path: string;
    summary: string;
    keyFiles: string[];
    contentHash: string;
    gitCommit: string | null;
    facts?: string[] | undefined;
    tags?: string[] | undefined;
    sourceSeen?: string | undefined;
    sourceTokens?: number | undefined;
    private?: true | undefined;
} | {
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
    needsReview?: true | undefined;
    stamps?: Record<string, string> | undefined;
    id: string;
    title: string;
    context: string;
    decision: string;
    consequences: string;
    supersedes: string | null;
    featureIds: string[];
} | {
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
    needsReview?: true | undefined;
    stamps?: Record<string, string> | undefined;
    id: string;
    title: string;
    description: string;
    status: "building" | "deprecated" | "planned" | "removed" | "shipped";
    protected: boolean;
    paths: string[];
    tests: string[];
    acceptance: string[];
    milestoneId: string | null;
} | {
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
    needsReview?: true | undefined;
    stamps?: Record<string, string> | undefined;
    id: string;
    title: string;
    goal: string;
    targetDate: string | null;
    status: "active" | "done" | "planned";
    order: number;
} | {
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
    needsReview?: true | undefined;
    stamps?: Record<string, string> | undefined;
    id: string;
    title: string;
    body: string;
    tags: string[];
    links: string[];
    pinned: boolean;
    private?: true | undefined;
    handoffTo?: string | undefined;
    handoffToName?: string | undefined;
    handoffFromName?: string | undefined;
    acknowledged?: {
        by: string;
        at: string;
    } | undefined;
} | {
    id: string;
    slug: string;
    name: string;
    repoUrl: string | null;
    mode: "git" | "standalone" | "stealth";
    settings: {
        leaseMinutes: number;
        review: "agents" | "all" | "none";
        autoContinue: boolean;
        kind?: "code" | "general" | undefined;
    };
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
} | {
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
    needsReview?: true | undefined;
    stamps?: Record<string, string> | undefined;
    id: string;
    title: string;
    body: string;
    status: "backlog" | "blocked" | "cancelled" | "done" | "in_progress" | "review" | "todo";
    priority: "high" | "low" | "medium" | "urgent";
    featureId: string | null;
    parentId: string | null;
    dependsOn: string[];
    labels: string[];
    branch: string | null;
    worktree: string | null;
    claim: {
        actorId: string;
        leaseUntil: string;
        heartbeatAt: string;
        token?: number | undefined;
        waiting?: {
            kind: "permission" | "question";
            text: string;
            since: string;
        } | undefined;
        holder?: {
            host: string;
            pid: number;
        } | undefined;
    } | null;
    completion: {
        summary: string;
        releaseNote?: string | undefined;
        filesTouched: string[];
        completedAt: string;
        completedBy: string;
        commit?: string | undefined;
        branch?: string | undefined;
        approvedCommit?: string | undefined;
    } | null;
    reviewNote?: string | null | undefined;
    blockedReason?: string | null | undefined;
    dueDate?: string | null | undefined;
    assigneeIds?: string[] | undefined;
    checklist?: {
        text: string;
        done: boolean;
    }[] | undefined;
    milestoneId?: string | null | undefined;
    effort?: "deep" | "light" | "standard" | null | undefined;
}>;
