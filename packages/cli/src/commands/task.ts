import {
  type ChecklistItem,
  CLI_NAME,
  claimNext,
  claimTask,
  completeTask,
  createTask,
  deleteRecord,
  getRecord,
  type ListTasksInput,
  listTasks,
  releaseTask,
  resolveId,
  restoreRecord,
  SatiError,
  type ServiceContext,
  shortHandle,
  type Task,
  type TaskRow,
  takeOverTask,
  taskRow,
  updateTask,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, pagination, taskId } from "../args.js";
import {
  askFiles,
  askSelect,
  askText,
  canAsk,
  missing,
  missingFlag,
  pickTask,
  sameAs,
} from "../prompt.js";
import { record, row, rows } from "../render.js";
import {
  bodyText,
  execute,
  heldTask,
  int,
  list,
  parseJson,
  ref,
  refs,
  someChange,
} from "../runtime.js";
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
    title: {
      type: "positional",
      required: false,
      description: "Task title (at a terminal: asked when left out)",
    },
    status: { type: "string", description: "backlog | todo (default todo)" },
    ...fields,
    subtasks: {
      type: "string",
      description:
        "JSON array of {title, body?, dependsOn?: number[], effort?}; dependsOn holds zero-based positions in this array",
    },
    ...json,
  },
  run: ({ args }) => {
    if (args.title === undefined && !canAsk(args.json)) throw missing("title", "task create");
    return execute(
      args.json,
      async ({ ctx }) => {
        // A person who typed no title is asked for it, then for the priority.
        const title = args.title ?? (await askText("Task title"));
        const priority =
          args.title === undefined && args.priority === undefined
            ? await askSelect("Priority", ["low", "medium", "high", "urgent"], "medium")
            : args.priority;
        if (args.title === undefined) {
          sameAs(
            "task",
            "create",
            title,
            ...(args.priority === undefined ? ["--priority", priority ?? "medium"] : []),
            ...typedAfter("create"),
          );
        }
        return createTask(ctx, {
          title,
          body: bodyText(args.body),
          status: args.status,
          priority,
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
        });
      },
      (t: Task) => `Created ${row(t)}`,
    );
  },
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

/** A task id that a person at a terminal may leave out, to choose from a list. */
const pickedId = {
  id: {
    type: "positional",
    required: false,
    description: "Task id or short handle (at a terminal: leave it out to choose)",
  },
} as const;

/** The flags a person typed after the command word, for the "Same as" line. */
function typedAfter(word: string): string[] {
  const argv = process.argv.slice(2);
  return argv.slice(argv.indexOf(word) + 1);
}

const noTasks = () =>
  new SatiError("NOT_FOUND", "No tasks.", {
    hint: `Create one with \`${CLI_NAME} task create "title"\`.`,
  });

/**
 * A missing id where nobody can be asked is the usage error it always was. Checked before the
 * project is opened, so the answer is the same outside one.
 */
function needsId(args: { id?: string | undefined; json?: boolean | undefined }, command: string) {
  if (args.id === undefined && !canAsk(args.json)) throw missing("id", command);
}

/** The task a command is about: the id typed, or the one a person picks from `filter`. */
async function taskOrPick(
  ctx: ServiceContext,
  args: { id?: string | undefined; json?: boolean | undefined },
  ask: { filter: ListTasksInput; message: string; empty: SatiError },
): Promise<{ id: string; picked: boolean }> {
  if (args.id !== undefined) return { id: await resolveId(ctx, "task", args.id), picked: false };
  return { id: await pickTask(ctx, ask.filter, ask.message, { empty: ask.empty }), picked: true };
}

const show = defineCommand({
  meta: { name: "show", description: "Show one task" },
  args: { ...taskId, ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        // With no id: the one task the caller holds; a person who holds none or several chooses.
        const held = await heldTask(ctx, args.id).catch((err: unknown) => {
          if (!canAsk(args.json)) throw err;
          return undefined;
        });
        const taskId =
          held ??
          (await pickTask(ctx, {}, "Show which task?", { empty: noTasks(), cancelled: "" }));
        if (held === undefined) sameAs("task", "show", shortHandle(taskId));
        return getRecord(ctx, "task", taskId);
      },
      record,
    ),
});

const update = defineCommand({
  meta: { name: "update", description: "Change a task (use `complete` to finish it)" },
  args: {
    ...pickedId,
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
  run: ({ args }) => {
    needsId(args, "task update");
    return execute(
      args.json,
      async ({ ctx }) => {
        // A typed id is checked first, as before; a person who typed none picks after the flags
        // are known to be good, so no choice is thrown away by a bad flag.
        const typed = args.id === undefined ? undefined : await resolveId(ctx, "task", args.id);
        const input = someChange(
          {
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
            reviewed: args.reviewed ? true : undefined,
            reason: args.reason,
          },
          "task update",
        );
        const taskId =
          typed ?? (await pickTask(ctx, {}, "Update which task?", { empty: noTasks() }));
        if (typed === undefined)
          sameAs("task", "update", shortHandle(taskId), ...typedAfter("update"));
        return updateTask(ctx, taskId, {
          ...input,
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      (t: Task) => `Updated ${row(t)}`,
    );
  },
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

/**
 * `task claim --pick`: a person chooses from the ready tasks, in the order `task claim` would
 * take them.
 */
async function pickReady(ctx: ServiceContext, conflict: boolean): Promise<string> {
  if (conflict || !canAsk()) {
    throw new SatiError(
      "USAGE",
      "--pick asks a question, so it needs a terminal and no id or --json.",
      {
        hint: `Run \`${CLI_NAME} task list --ready\`, then \`${CLI_NAME} task claim <id>\`.`,
      },
    );
  }
  return pickTask(ctx, { ready: true }, "Claim which task?", {
    empty: new SatiError("NOT_FOUND", "No ready task.", {
      hint: `Create one with \`${CLI_NAME} task create\`, or see \`${CLI_NAME} task list\`.`,
    }),
    cancelled: "Nothing claimed.",
  });
}

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
    pick: { type: "boolean", description: "Choose from the ready tasks (needs a terminal)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const leaseMinutes = int(args.lease, "lease");
        if (args.pick) {
          const chosen = await pickReady(ctx, args.id !== undefined || args.json === true);
          return claimTask(ctx, chosen, { leaseMinutes });
        }
        // A person with several ready tasks chooses; the top one is first, so Enter takes what
        // `task claim` always took. Scripts and agents get the top one without a question.
        if (!args.id && canAsk(args.json)) {
          const ready = await listTasks(ctx, { ready: true, limit: 2 });
          if (ready.length > 1) {
            const chosen = await pickReady(ctx, false);
            sameAs("task", "claim", shortHandle(chosen));
            return claimTask(ctx, chosen, { leaseMinutes });
          }
        }
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
    ...taskId,
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
        releaseTask(ctx, await heldTask(ctx, args.id), { force: args.force ?? false }),
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
    ...taskId,
    summary: {
      type: "string",
      description: "What was done (required; at a terminal: asked when left out)",
    },
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
  run: ({ args }) => {
    if (args.summary === undefined && !canAsk(args.json)) {
      throw missingFlag("summary", "task complete");
    }
    return execute(
      args.json,
      async ({ ctx, location }) => {
        const taskId = await heldTask(ctx, args.id);
        // A person who typed no summary is asked for it, and for the files when none were given:
        // the ones git says this worktree changed are offered, already ticked.
        const summary = args.summary ?? (await askText("What was done?"));
        let files = list(args.files);
        if (args.summary === undefined && files === undefined) {
          const changed = (await ctx.repo?.changedFiles?.(location.root)) ?? [];
          const offered = changed.filter((f) => !f.startsWith(".sati/")).sort();
          files = await askFiles("Files touched", offered);
        }
        if (args.summary === undefined) {
          sameAs(
            "task",
            "complete",
            shortHandle(taskId),
            "--summary",
            summary,
            ...(files?.length && args.files === undefined ? ["--files", files.join(",")] : []),
            ...typedAfter("complete").filter((w) => w !== args.id),
          );
        }
        return completeTask(ctx, taskId, {
          summary,
          releaseNote: args["release-note"],
          filesTouched: files?.length ? files : undefined,
          expectedVersion: int(args["expected-version"], "expected-version"),
          token: await claimToken(ctx, taskId, args.token),
        });
      },
      (t: Task) =>
        t.status === "review"
          ? `Completed ${row(t)}\n  Waiting for a person to approve it (settings --review).`
          : `Completed ${row(t)}`,
    );
  },
});

const noneInReview = () =>
  new SatiError("NOT_FOUND", "No task waits for approval.", {
    hint: `See what waits for you with \`${CLI_NAME} inbox\`.`,
  });
const inReview = (message: string) => ({
  filter: { status: ["review"] },
  message,
  empty: noneInReview(),
});

const approve = defineCommand({
  meta: {
    name: "approve",
    description:
      "Approve a task in review: it moves to done (people only). The same as `task update <id> --status done`",
  },
  args: {
    ...pickedId,
    commit: {
      type: "string",
      description: "The commit you looked at; refused if the branch moved since",
    },
    ...json,
  },
  run: ({ args }) => {
    needsId(args, "task approve");
    return execute(
      args.json,
      async ({ ctx }) => {
        const task = await taskOrPick(ctx, args, inReview("Approve which task?"));
        if (task.picked) sameAs("task", "approve", shortHandle(task.id));
        return updateTask(ctx, task.id, { status: "done", approvedCommit: args.commit });
      },
      (t: Task) => `Approved ${row(t)}`,
    );
  },
});

const sendBack = defineCommand({
  meta: {
    name: "send-back",
    description:
      "Send a task in review back to todo with what to change (the next claimer sees it). The same as `task update <id> --status todo --reason`",
  },
  args: {
    ...pickedId,
    reason: { type: "string", description: "What to change" },
    ...json,
  },
  run: ({ args }) => {
    if (args.reason === undefined && !canAsk(args.json)) {
      throw new SatiError("USAGE", "Missing --reason.", {
        hint: `Run \`${CLI_NAME} task send-back <id> --reason "what to change"\`.`,
      });
    }
    needsId(args, "task send-back");
    return execute(
      args.json,
      async ({ ctx }) => {
        const task = await taskOrPick(ctx, args, inReview("Send back which task?"));
        const reason = args.reason ?? (await askText("What should change?"));
        if (task.picked || args.reason === undefined) {
          sameAs("task", "send-back", shortHandle(task.id), "--reason", reason);
        }
        return updateTask(ctx, task.id, { status: "todo", reason });
      },
      (t: Task) => `Sent back ${row(t)}`,
    );
  },
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
    approve,
    "send-back": sendBack,
    release,
    "take-over": takeOver,
    complete,
    delete: remove,
    restore,
  },
});
