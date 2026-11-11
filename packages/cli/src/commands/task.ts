import {
  type ChecklistItem,
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
  SatiError,
  type ServiceContext,
  type Task,
  type TaskRow,
  takeOverTask,
  taskRow,
  updateTask,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, pagination } from "../args.js";
import { record, row, rows } from "../render.js";
import { bodyText, execute, int, list, parseJson, ref, refs } from "../runtime.js";
import { when } from "../term.js";

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

/** `none` clears a planning field from the command line. */
const NONE = "none";

/** `--due` and `--effort`: a value, or `none` to clear the field. Core checks the value. */
function orNone(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === NONE ? null : value;
}

/**
 * `--milestone`, `--feature` and `--parent` on create and update: an id or handle, or `none` to
 * clear the link.
 */
async function link(
  ctx: ServiceContext,
  entity: "milestone" | "feature" | "task",
  value: string | undefined,
): Promise<string | null | undefined> {
  return value === NONE ? null : ref(ctx, entity, value);
}

/** `--depends`: comma-separated ids or handles, or `none` to clear the list. */
async function depends(ctx: ServiceContext, value: string | undefined) {
  return value === NONE ? [] : refs(ctx, "task", value);
}

/**
 * `--assign`: comma-separated actor names, ids or handles, `me`, or `none` to clear. People
 * know each other by name, so a name is looked up before it is treated as an id.
 */
async function assignees(
  ctx: ServiceContext,
  value: string | undefined,
): Promise<string[] | undefined> {
  if (value === undefined) return undefined;
  if (value === NONE) return [];
  const out: string[] = [];
  for (const item of list(value) ?? []) {
    if (item === "me") {
      out.push(ctx.actorId);
      continue;
    }
    const named = await ctx.store.read((r) => r.getByKey("actor", ctx.projectId, item));
    out.push(named ? named.id : await resolveId(ctx, "actor", item));
  }
  return [...new Set(out)];
}

/** `task list --assignee`: one person, since the filter matches one; `none` is not a filter. */
async function oneAssignee(ctx: ServiceContext, value: string | undefined) {
  const ids = await assignees(ctx, value);
  if (ids === undefined) return undefined;
  if (ids.length !== 1) {
    throw new SatiError("USAGE", "--assignee takes one name, id or me.", {
      hint: "List each person's tasks separately.",
    });
  }
  return ids[0];
}

const fields = {
  body: { type: "string", description: "Details in Markdown (- reads stdin)" },
  priority: { type: "string", description: "low | medium | high | urgent" },
  effort: {
    type: "string",
    description: "light (fine for a small model) | standard | deep, or none",
  },
  feature: { type: "string", description: "Feature id or handle, or none" },
  parent: { type: "string", description: "Parent task id or handle, or none" },
  depends: { type: "string", description: "Comma-separated task ids this task waits on, or none" },
  // `task list` filters with --label; both spellings work on every task command (review 5.1).
  labels: { type: "string", alias: "label", description: "Comma-separated labels" },
  branch: { type: "string", description: "Git branch for this task" },
  worktree: { type: "string", description: "Worktree path for this task" },
  due: { type: "string", description: "Due day YYYY-MM-DD, or none" },
  milestone: { type: "string", description: "Milestone (plan) id or handle, or none" },
  assign: {
    type: "string",
    description: "Who should do it: comma-separated names, ids or me, or none",
  },
} as const;

const create = defineCommand({
  meta: { name: "create", description: "Create a task" },
  args: {
    title: { type: "positional", required: true, description: "Task title" },
    status: { type: "string", description: "backlog | todo (default todo)" },
    ...fields,
    subtasks: {
      type: "string",
      description:
        "JSON array of {title, body?, dependsOn?: number[], effort?}; dependsOn holds zero-based positions in this array",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        createTask(ctx, {
          title: args.title,
          body: bodyText(args.body),
          status: args.status,
          priority: args.priority,
          effort: orNone(args.effort),
          featureId: await link(ctx, "feature", args.feature),
          parentId: await link(ctx, "task", args.parent),
          dependsOn: await depends(ctx, args.depends),
          labels: list(args.labels),
          branch: args.branch,
          worktree: args.worktree,
          dueDate: orNone(args.due),
          milestoneId: await link(ctx, "milestone", args.milestone),
          assigneeIds: await assignees(ctx, args.assign),
          subtasks: args.subtasks ? parseJson(args.subtasks, "--subtasks", "USAGE") : undefined,
        }),
      (t: Task) => `Created ${row(t)}`,
    ),
});

const ls = defineCommand({
  meta: { name: "list", description: "List tasks" },
  args: {
    status: {
      type: "string",
      description: "Comma-separated: backlog, todo, in_progress, blocked, review, done, cancelled",
    },
    feature: { type: "string", description: "Only tasks of this feature" },
    milestone: {
      type: "string",
      description: "Only tasks in this milestone, directly or through their feature",
    },
    label: { type: "string", alias: "labels", description: "Only tasks with this label" },
    "due-by": { type: "string", description: "Only tasks due on or before YYYY-MM-DD" },
    assignee: { type: "string", description: "Only tasks assigned to this name, id or me" },
    effort: { type: "string", description: "Only tasks of this effort: light | standard | deep" },
    ready: {
      type: "boolean",
      description: "Only todo tasks with no claim and all dependencies done",
    },
    full: {
      type: "boolean",
      description: "Whole records with --json (body, completion); by default short rows",
    },
    ...pagination,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const tasks = await listTasks(ctx, {
          status: list(args.status),
          featureId: await ref(ctx, "feature", args.feature),
          milestoneId: await ref(ctx, "milestone", args.milestone),
          label: args.label,
          dueBy: args["due-by"],
          assigneeId: await oneAssignee(ctx, args.assignee),
          effort: args.effort,
          ready: args.ready,
          limit: int(args.limit, "limit"),
          offset: int(args.offset, "offset"),
        });
        // Agents read this list often: short rows cost a fraction of the tokens.
        return args.full ? tasks : tasks.map(taskRow);
      },
      (tasks: (Task | TaskRow)[]) =>
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
    status: {
      type: "string",
      description:
        "New status. done approves a task in review (people only); otherwise finish with complete",
    },
    ...fields,
    ...expectedVersion,
    ...token,
    reviewed: { type: "boolean", description: "Clear needsReview" },
    reason: {
      type: "string",
      description: "Why a review task goes back to todo, or what a blocked task waits on",
    },
    "needs-input": {
      type: "string",
      description: "Ask a person this question; your next write clears it",
    },
    "approved-commit": {
      type: "string",
      description: "Approving: the commit you looked at; refused if the branch moved since",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const taskId = await resolveId(ctx, "task", args.id);
        return updateTask(ctx, taskId, {
          needsInput: args["needs-input"],
          approvedCommit: args["approved-commit"],
          title: args.title,
          body: bodyText(args.body),
          status: args.status,
          priority: args.priority,
          effort: orNone(args.effort),
          featureId: await link(ctx, "feature", args.feature),
          parentId: await link(ctx, "task", args.parent),
          dependsOn: await depends(ctx, args.depends),
          labels: list(args.labels),
          branch: args.branch,
          worktree: args.worktree,
          dueDate: orNone(args.due),
          milestoneId: await link(ctx, "milestone", args.milestone),
          assigneeIds: await assignees(ctx, args.assign),
          expectedVersion: int(args["expected-version"], "expected-version"),
          token: await claimToken(ctx, taskId, args.token),
          reviewed: args.reviewed ? true : undefined,
          reason: args.reason,
        });
      },
      (t: Task) => `Updated ${row(t)}`,
    ),
});

/** The checklist as numbered lines, so `--done 2` refers to what the person sees. */
function checklistText(t: Task): string {
  const items = t.checklist ?? [];
  if (items.length === 0) return `${row(t)}\n  No checklist. Add a step with --add "text".`;
  const lines = items.map((c, i) => `  ${i + 1}. [${c.done ? "x" : " "}] ${c.text}`);
  return [row(t), ...lines].join("\n");
}

const checklist = defineCommand({
  meta: {
    name: "checklist",
    description: "Show a task's checklist, or add, tick, untick or remove a step",
  },
  args: {
    ...id("Task"),
    add: { type: "string", description: "Add a step with this text" },
    done: { type: "string", description: "Tick step number N" },
    undone: { type: "string", description: "Untick step number N" },
    remove: { type: "string", description: "Remove step number N" },
    ...token,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const taskId = await resolveId(ctx, "task", args.id);
        const t = await getRecord(ctx, "task", taskId);
        const items: ChecklistItem[] = [...(t.checklist ?? [])];
        const step = (flag: "done" | "undone" | "remove") => {
          const n = int(args[flag], flag);
          if (n === undefined) return undefined;
          if (n < 1 || n > items.length) {
            throw new SatiError(
              "USAGE",
              `--${flag} ${n}: the checklist has ${items.length} steps.`,
            );
          }
          return n - 1;
        };
        const done = step("done");
        const undone = step("undone");
        const removed = step("remove");
        if (done !== undefined && items[done]) items[done] = { ...items[done], done: true };
        if (undone !== undefined && items[undone])
          items[undone] = { ...items[undone], done: false };
        if (removed !== undefined) items.splice(removed, 1);
        if (args.add !== undefined) items.push({ text: args.add, done: false });
        const changed =
          args.add !== undefined ||
          done !== undefined ||
          undone !== undefined ||
          removed !== undefined;
        if (!changed) return t;
        // The version read above guards the whole list against a change made meanwhile.
        return updateTask(ctx, taskId, {
          checklist: items,
          expectedVersion: t.version,
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      checklistText,
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
        `Claimed ${row(t)} until ${when(t.claim?.leaseUntil)}, token ${t.claim?.token}${
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
        restoreRecord(
          ctx,
          "task",
          await resolveId(ctx, "task", args.id, { deleted: true }),
        ) as Promise<Task>,
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
      (t: Task) =>
        `Took over ${row(t)} until ${when(t.claim?.leaseUntil)}, token ${t.claim?.token}`,
    ),
});

const complete = defineCommand({
  meta: {
    name: "complete",
    description:
      "Finish a task with a summary of what changed (an agent's task goes to review when the review setting asks for approval)",
  },
  args: {
    ...id("Task"),
    summary: { type: "string", required: true, description: "What was done" },
    "release-note": {
      type: "string",
      description: "One line for users, for the changelog (default: the summary)",
    },
    files: {
      type: "string",
      description: "Comma-separated files touched (required in a code project)",
    },
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
          releaseNote: args["release-note"],
          filesTouched: list(args.files),
          expectedVersion: int(args["expected-version"], "expected-version"),
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      (t: Task) =>
        t.status === "review"
          ? `Completed ${row(t)}\n  Waiting for a person to approve it (settings --review).`
          : `Completed ${row(t)}`,
    ),
});

export default defineCommand({
  meta: { name: "task", description: "Create, list and finish tasks" },
  subCommands: {
    create,
    list: ls,
    show,
    update,
    checklist,
    claim,
    release,
    "take-over": takeOver,
    complete,
    delete: remove,
    restore,
  },
});
