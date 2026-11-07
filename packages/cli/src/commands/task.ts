import {
  CLI_NAME,
  claimNext,
  claimTask,
  completeTask,
  createTask,
  deleteRecord,
  getRecord,
  listTasks,
  releaseTask,
  resolveId,
  restoreRecord,
  type ServiceContext,
  type Task,
  takeOverTask,
  updateTask,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, pagination } from "../args.js";
import { record, row, rows } from "../render.js";
import { execute, int, list, parseJson, ref, refs } from "../runtime.js";

const token = {
  token: {
    type: "string",
    description: "Fencing token from `task claim` (default: yours, if you hold the claim)",
  },
} as const;

/**
 * The fencing token for a write. Each CLI call is a new process with no memory of the claim, so
 * without `--token` it uses the claim's token only when the caller holds it. If another agent
 * has taken the task over, the caller is not the holder and the write is refused.
 */
async function claimToken(
  ctx: ServiceContext,
  taskId: string,
  flag: string | undefined,
): Promise<number | undefined> {
  if (flag !== undefined) return int(flag, "token");
  const t = await getRecord(ctx, "task", taskId);
  return t.claim?.actorId === ctx.actorId ? t.claim.token : undefined;
}

const fields = {
  body: { type: "string", description: "Details in Markdown" },
  priority: { type: "string", description: "low | medium | high | urgent" },
  feature: { type: "string", description: "Feature id or handle" },
  parent: { type: "string", description: "Parent task id or handle" },
  depends: { type: "string", description: "Comma-separated task ids this task waits on" },
  labels: { type: "string", description: "Comma-separated labels" },
  branch: { type: "string", description: "Git branch for this task" },
  worktree: { type: "string", description: "Worktree path for this task" },
} as const;

const create = defineCommand({
  meta: { name: "create", description: "Create a task" },
  args: {
    title: { type: "positional", required: true, description: "Task title" },
    status: { type: "string", description: "backlog | todo (default todo)" },
    ...fields,
    subtasks: {
      type: "string",
      description: "JSON array of {title, body?, dependsOn?: number[]}",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        createTask(ctx, {
          title: args.title,
          body: args.body,
          status: args.status,
          priority: args.priority,
          featureId: await ref(ctx, "feature", args.feature),
          parentId: await ref(ctx, "task", args.parent),
          dependsOn: await refs(ctx, "task", args.depends),
          labels: list(args.labels),
          branch: args.branch,
          worktree: args.worktree,
          subtasks: args.subtasks ? parseJson(args.subtasks, "--subtasks", "USAGE") : undefined,
        }),
      (t: Task) => `Created ${row(t)}`,
    ),
});

const ls = defineCommand({
  meta: { name: "list", description: "List tasks" },
  args: {
    status: { type: "string", description: "Comma-separated statuses" },
    feature: { type: "string", description: "Only tasks of this feature" },
    milestone: {
      type: "string",
      description: "Only tasks whose feature belongs to this milestone",
    },
    label: { type: "string", description: "Only tasks with this label" },
    ready: { type: "boolean", description: "Only unclaimed tasks whose dependencies are done" },
    ...pagination,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        listTasks(ctx, {
          status: list(args.status),
          featureId: await ref(ctx, "feature", args.feature),
          milestoneId: await ref(ctx, "milestone", args.milestone),
          label: args.label,
          ready: args.ready,
          limit: int(args.limit, "limit"),
          offset: int(args.offset, "offset"),
        }),
      (tasks: Task[]) =>
        rows(tasks, `No tasks. Create one with \`${CLI_NAME} task create "title"\`.`),
    ),
});

const show = defineCommand({
  meta: { name: "show", description: "Show one task" },
  args: { ...id("Task"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => getRecord(ctx, "task", await resolveId(ctx, "task", args.id)),
      record,
    ),
});

const update = defineCommand({
  meta: { name: "update", description: "Change a task (use `complete` to finish it)" },
  args: {
    ...id("Task"),
    title: { type: "string", description: "New title" },
    status: { type: "string", description: "New status" },
    ...fields,
    ...expectedVersion,
    ...token,
    reviewed: { type: "boolean", description: "Clear needsReview" },
    reason: { type: "string", description: "Why a review task is going back to todo" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const taskId = await resolveId(ctx, "task", args.id);
        return updateTask(ctx, taskId, {
          title: args.title,
          body: args.body,
          status: args.status,
          priority: args.priority,
          featureId: await ref(ctx, "feature", args.feature),
          parentId: await ref(ctx, "task", args.parent),
          dependsOn: await refs(ctx, "task", args.depends),
          labels: list(args.labels),
          branch: args.branch,
          worktree: args.worktree,
          expectedVersion: int(args["expected-version"], "expected-version"),
          token: await claimToken(ctx, taskId, args.token),
          reviewed: args.reviewed ? true : undefined,
          reason: args.reason,
        });
      },
      (t: Task) => `Updated ${row(t)}`,
    ),
});

const claim = defineCommand({
  meta: {
    name: "claim",
    description: "Claim a task before working on it (moves it to in_progress)",
  },
  args: {
    id: {
      type: "positional",
      required: false,
      description: "Task id, or omit to claim the top ready task",
    },
    lease: { type: "string", description: "Lease length in minutes (default: project setting)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const leaseMinutes = int(args.lease, "lease");
        if (!args.id) {
          const next = await claimNext(ctx, { leaseMinutes });
          return { ...next.task, acceptance: next.acceptance };
        }
        return claimTask(ctx, await resolveId(ctx, "task", args.id), { leaseMinutes });
      },
      (t: Task & { acceptance?: string[] }) =>
        `Claimed ${row(t)} until ${t.claim?.leaseUntil}, token ${t.claim?.token}${
          t.acceptance?.length ? `\n${t.acceptance.map((a) => `- ${a}`).join("\n")}` : ""
        }`,
    ),
});

const remove = defineCommand({
  meta: { name: "delete", description: "Soft-delete a task" },
  args: { ...id("Task"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        deleteRecord(ctx, "task", await resolveId(ctx, "task", args.id)) as Promise<Task>,
      (t: Task) => `Deleted ${row(t)}`,
    ),
});

const restore = defineCommand({
  meta: { name: "restore", description: "Restore a soft-deleted task" },
  args: { ...id("Task"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        restoreRecord(ctx, "task", await resolveId(ctx, "task", args.id)) as Promise<Task>,
      (t: Task) => `Restored ${row(t)}`,
    ),
});

const release = defineCommand({
  meta: {
    name: "release",
    description: "Give up a claim (an in_progress task goes back to todo)",
  },
  args: {
    ...id("Task"),
    force: {
      type: "boolean",
      description: "Release another actor's live claim (people only; logged)",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        releaseTask(ctx, await resolveId(ctx, "task", args.id), { force: args.force ?? false }),
      (t: Task) => `Released ${row(t)}`,
    ),
});

const takeOver = defineCommand({
  meta: {
    name: "take-over",
    description: "Take a task from its holder and claim it yourself (people only; logged)",
  },
  args: {
    ...id("Task"),
    lease: { type: "string", description: "Lease length in minutes (default: project setting)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        takeOverTask(ctx, await resolveId(ctx, "task", args.id), {
          leaseMinutes: int(args.lease, "lease"),
        }),
      (t: Task) => `Took over ${row(t)} until ${t.claim?.leaseUntil}, token ${t.claim?.token}`,
    ),
});

const complete = defineCommand({
  meta: { name: "complete", description: "Finish a task with a summary of what changed" },
  args: {
    ...id("Task"),
    summary: { type: "string", required: true, description: "What was done" },
    files: { type: "string", required: true, description: "Comma-separated files touched" },
    ...expectedVersion,
    ...token,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const taskId = await resolveId(ctx, "task", args.id);
        return completeTask(ctx, taskId, {
          summary: args.summary,
          filesTouched: list(args.files),
          expectedVersion: int(args["expected-version"], "expected-version"),
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      (t: Task) => `Completed ${row(t)}`,
    ),
});

export default defineCommand({
  meta: { name: "task", description: "Create, list and finish tasks" },
  subCommands: {
    create,
    list: ls,
    show,
    update,
    claim,
    release,
    "take-over": takeOver,
    complete,
    delete: remove,
    restore,
  },
});
