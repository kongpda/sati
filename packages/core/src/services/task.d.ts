import { z } from "zod";
import { type Task } from "../domain/schemas.js";
import type { StorageWriter } from "../ports/storage.js";
import { type ServiceContext } from "./context.js";
/** New tasks start in `backlog` or `todo`; later states need the update and complete flows. */
export declare const CreateTaskInput: z.ZodObject<{
    title: z.ZodString;
    priority: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        medium: "medium";
        urgent: "urgent";
    }>>;
    featureId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    parentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dependsOn: z.ZodOptional<z.ZodArray<z.ZodString>>;
    labels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    worktree: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dueDate: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    assigneeIds: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
    checklist: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        done: z.ZodBoolean;
    }, z.core.$strict>>>>;
    milestoneId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    effort: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        deep: "deep";
        light: "light";
        standard: "standard";
    }>>>>;
    body: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        backlog: "backlog";
        todo: "todo";
    }>>;
    subtasks: z.ZodOptional<z.ZodArray<z.ZodObject<{
        title: z.ZodString;
        body: z.ZodOptional<z.ZodString>;
        dependsOn: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const UpdateTaskInput: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        backlog: "backlog";
        blocked: "blocked";
        cancelled: "cancelled";
        done: "done";
        in_progress: "in_progress";
        review: "review";
        todo: "todo";
    }>>;
    priority: z.ZodOptional<z.ZodEnum<{
        high: "high";
        low: "low";
        medium: "medium";
        urgent: "urgent";
    }>>;
    featureId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    parentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dependsOn: z.ZodOptional<z.ZodArray<z.ZodString>>;
    labels: z.ZodOptional<z.ZodArray<z.ZodString>>;
    branch: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    worktree: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dueDate: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    assigneeIds: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString>>>;
    checklist: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodObject<{
        text: z.ZodString;
        done: z.ZodBoolean;
    }, z.core.$strict>>>>;
    milestoneId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    effort: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        deep: "deep";
        light: "light";
        standard: "standard";
    }>>>>;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
    body: z.ZodOptional<z.ZodString>;
    token: z.ZodOptional<z.ZodNumber>;
    reviewed: z.ZodOptional<z.ZodLiteral<true>>;
    reason: z.ZodOptional<z.ZodString>;
    needsInput: z.ZodOptional<z.ZodString>;
    approvedCommit: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export declare const CompleteTaskInput: z.ZodObject<{
    summary: z.ZodString;
    releaseNote: z.ZodOptional<z.ZodString>;
    filesTouched: z.ZodOptional<z.ZodArray<z.ZodString>>;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
    token: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const ClaimTaskInput: z.ZodObject<{
    leaseMinutes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const WaitingInput: z.ZodObject<{
    taskId: z.ZodOptional<z.ZodString>;
    waiting: z.ZodNullable<z.ZodObject<{
        kind: z.ZodDefault<z.ZodEnum<{
            permission: "permission";
            question: "question";
        }>>;
        text: z.ZodString;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type WaitingInput = z.input<typeof WaitingInput>;
export declare const ReleaseTaskInput: z.ZodObject<{
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const ListTasksInput: z.ZodObject<{
    status: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        [x: string]: string;
    }> | z.ZodNever>>;
    featureId: z.ZodOptional<z.ZodString>;
    milestoneId: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodString>;
    includeDeleted: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
    ready: z.ZodOptional<z.ZodBoolean>;
    dueBy: z.ZodOptional<z.ZodString>;
    assigneeId: z.ZodOptional<z.ZodString>;
    effort: z.ZodOptional<z.ZodEnum<{
        deep: "deep";
        light: "light";
        standard: "standard";
    }>>;
}, z.core.$strict>;
export type CreateTaskInput = z.input<typeof CreateTaskInput>;
export type UpdateTaskInput = z.input<typeof UpdateTaskInput>;
export type CompleteTaskInput = z.input<typeof CompleteTaskInput>;
export type ListTasksInput = z.input<typeof ListTasksInput>;
export type ClaimTaskInput = z.input<typeof ClaimTaskInput>;
export declare function createTask(ctx: ServiceContext, input: unknown): Promise<Task>;
/** `createTask` inside a caller's transaction, for services that write several records at once. */
export declare function createTaskIn(w: StorageWriter, ctx: ServiceContext, parsed: z.output<typeof CreateTaskInput>): Promise<Task>;
/** Edits a task. Use `completeTask` to reach `done`; reopening a done task clears its completion. */
export declare function updateTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task>;
/** Marks a task done with a summary and the files touched, and releases its claim and locks. */
export declare function completeTask(ctx: ServiceContext, id: string, input: unknown): Promise<Task>;
/** What a claim hands the new holder: the handoff note left on the task, as data. */
export interface DeliveredHandoff {
    id: string;
    from: string;
    body: string;
}
export declare function claimTask(ctx: ServiceContext, id: string, input?: unknown): Promise<Task & {
    handoff?: DeliveredHandoff;
}>;
/** Releases a task's claim; see `applyRelease` for who may. */
export declare function releaseTask(ctx: ServiceContext, id: string, input?: unknown): Promise<Task>;
/**
 * A person takes a task over in one transaction: the current claim is released (forced and
 * logged when it is someone else's and still live), then the caller claims it with a new token,
 * so the previous holder's next write is refused.
 */
export declare function takeOverTask(ctx: ServiceContext, id: string, input?: unknown): Promise<Task & {
    handoff?: DeliveredHandoff;
}>;
/**
 * Claims the top ready task in the same transaction that picks it: highest priority, then
 * oldest id. Two callers queue on the store, so they cannot receive the same task.
 */
export declare function claimNext(ctx: ServiceContext, input?: unknown): Promise<{
    task: Task & {
        handoff?: DeliveredHandoff;
    };
    acceptance: string[];
}>;
/** A holder that wrote within this window is never called gone, whatever the process check says. */
export declare const HOLDER_QUIET_MS = 60000;
export interface ClaimHealth {
    /** Live claims whose holder process has exited on this machine and has been quiet a minute. */
    gone: Task[];
    /**
     * True when most probed holders looked gone at once, which points at the check (a container
     * that cannot see the host's processes, say), not at that many agents dying. Nothing is gone.
     */
    tripped: boolean;
    /** How many claims could be checked: they name a holder on this machine. */
    probed: number;
}
/**
 * Which live claims belong to an agent whose process is gone. Only a definite "exited" from
 * the process check counts; an unknown answer, another host or a recent write keeps the claim
 * until its lease runs out.
 */
export declare function claimHealth(ctx: ServiceContext, tasks: readonly Task[]): ClaimHealth;
/**
 * Points the caller's live claims at this process when the process that held them has exited.
 * An agent tool that restarts its MCP server (a reload or reconnect) keeps working on the same
 * tasks under a new process id; without this its claims would look abandoned. A holder that is
 * still running (another session as the same actor) or that this machine cannot check keeps them.
 */
export declare function adoptClaims(ctx: ServiceContext): Promise<Task[]>;
/**
 * Clears claims whose lease has run out, or whose holder process has exited (see
 * `claimHealth`), so abandoned work returns to the pool: an `in_progress` task goes back to
 * `todo`; `review` and `blocked` tasks keep their status. Writes only when something is
 * released. Returns the released tasks.
 */
export declare function releaseExpiredClaims(ctx: ServiceContext): Promise<Task[]>;
/**
 * Marks the caller's held tasks as waiting on a person, or clears that. The holder sets it;
 * the holder or a person clears it (a person answered in the agent's session). Setting it is a
 * holder write, so it renews the lease: an agent waiting on a person keeps its task.
 */
export declare function markWaiting(ctx: ServiceContext, input: unknown): Promise<Task[]>;
/** Where a task in review stands against its branch: whether commits landed after it was sent. */
export interface ReviewDrift {
    commit: string;
    branch: string;
    /** The branch's commit now; null when the branch is gone. */
    head: string | null;
    /** True when the branch points elsewhere than the commit the work was sent at. */
    moved: boolean;
}
/** Review drift for each task that was finished at a known commit. Needs git; empty without it. */
export declare function reviewDrift(ctx: ServiceContext, tasks: readonly Task[]): Promise<Map<string, ReviewDrift>>;
/**
 * Lists tasks; `ready: true` returns todo, unclaimed tasks whose dependencies are done.
 * `milestoneId` matches a task whose own `milestoneId` is that milestone, or whose feature is in
 * it, so the milestone's features are looked up before the store sees the query.
 * The store's ready query takes no filters, so the filters and paging apply here to up to 500
 * ready tasks. `includeDeleted` has no effect on ready tasks: a deleted task is never ready.
 */
export declare function listTasks(ctx: ServiceContext, input?: unknown): Promise<Task[]>;
/** A task as a list row; see `taskRow`. */
export type TaskRow = Pick<Task, "id" | "title" | "status" | "priority" | "version"> & Partial<Pick<Task, "featureId" | "milestoneId" | "parentId" | "dependsOn" | "labels" | "dueDate" | "assigneeIds" | "effort" | "reviewNote" | "needsReview">> & {
    claim?: {
        actorId: string;
        leaseUntil: string;
    };
    /** Steps done of all, as "2/5". */
    checklist?: string;
};
/**
 * A task as a list row: what an agent needs to pick, filter or update it (version for
 * expectedVersion), with empty and unset fields left out. A full record carries the body,
 * completion and per-field stamps, several times the size; MCP `task_list` asks for it with
 * `detail: "full"`, the CLI with `--full`.
 */
export declare function taskRow(t: Task): TaskRow;
