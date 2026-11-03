import {
  claimTask,
  completeTask,
  createTask,
  getRecord,
  listTasks,
  resolveId,
  type Task,
  updateTask,
} from "@brain/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, pagination } from "../args.js";
import { record, row, rows } from "../render.js";
import { execute, int, list, ref, refs } from "../runtime.js";

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
        }),
      (t: Task) => `Created ${row(t)}`,
    ),
});

const ls = defineCommand({
  meta: { name: "list", description: "List tasks" },
  args: {
    status: { type: "string", description: "Comma-separated statuses" },
    feature: { type: "string", description: "Only tasks of this feature" },
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
          label: args.label,
          ready: args.ready,
          limit: int(args.limit, "limit"),
          offset: int(args.offset, "offset"),
        }),
      (tasks: Task[]) => rows(tasks, 'No tasks. Create one with `brain task create "title"`.'),
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
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        updateTask(ctx, await resolveId(ctx, "task", args.id), {
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
        }),
      (t: Task) => `Updated ${row(t)}`,
    ),
});

const claim = defineCommand({
  meta: {
    name: "claim",
    description: "Claim a task before working on it (moves it to in_progress)",
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
        claimTask(ctx, await resolveId(ctx, "task", args.id), {
          leaseMinutes: int(args.lease, "lease"),
        }),
      (t: Task) => `Claimed ${row(t)} until ${t.claim?.leaseUntil}`,
    ),
});

const complete = defineCommand({
  meta: { name: "complete", description: "Finish a task with a summary of what changed" },
  args: {
    ...id("Task"),
    summary: { type: "string", required: true, description: "What was done" },
    files: { type: "string", required: true, description: "Comma-separated files touched" },
    ...expectedVersion,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        completeTask(ctx, await resolveId(ctx, "task", args.id), {
          summary: args.summary,
          filesTouched: list(args.files),
          expectedVersion: int(args["expected-version"], "expected-version"),
        }),
      (t: Task) => `Completed ${row(t)}`,
    ),
});

export default defineCommand({
  meta: { name: "task", description: "Create, list and finish tasks" },
  subCommands: { create, list: ls, show, update, claim, complete },
});
