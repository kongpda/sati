import {
  CLI_NAME,
  listTasks,
  SatiError,
  type ServiceContext,
  TASK_STATUSES,
  type Task,
  type TaskRow,
  taskRow,
} from "@sati/core";
import { defineCommand } from "citty";
import { json, pagination } from "../../args.js";
import { BOARD_STATUSES, type BoardColumn, boardText } from "../../board.js";
import { rows } from "../../render.js";
import { int, list, ref } from "../../runtime/input.js";
import { execute } from "../../runtime/output.js";
import { term } from "../../term.js";
import { assignees } from "./shared.js";

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

/** Rows read for one column of `task list --board`; a fuller column shows its count as "500+". */
const COLUMN_CAP = 500;

interface BoardArgs {
  status?: string | undefined;
  feature?: string | undefined;
  milestone?: string | undefined;
  label?: string | undefined;
  "due-by"?: string | undefined;
  assignee?: string | undefined;
  effort?: string | undefined;
  ready?: boolean | undefined;
  limit?: string | undefined;
  offset?: string | undefined;
  json?: boolean | undefined;
}

/** `task list --board`: the tasks under their status, as the board lays them out. Printed once. */
function board(args: BoardArgs): Promise<void> {
  if (args.ready || args.offset !== undefined) {
    throw new SatiError(
      "USAGE",
      `--board does not go with ${args.ready ? "--ready" : "--offset"}.`,
      {
        hint: `Run \`${CLI_NAME} task list --help\` for usage.`,
      },
    );
  }
  const perColumn = int(args.limit, "limit") ?? 10;
  if (perColumn < 1) throw new SatiError("USAGE", `--limit must be 1 or more, got ${perColumn}.`);
  return execute(
    args.json,
    async ({ ctx }) => {
      const filter = {
        featureId: await ref(ctx, "feature", args.feature),
        milestoneId: await ref(ctx, "milestone", args.milestone),
        label: args.label,
        dueBy: args["due-by"],
        assigneeId: await oneAssignee(ctx, args.assignee),
        effort: args.effort,
      };
      const columns: BoardColumn[] = [];
      for (const status of list(args.status) ?? BOARD_STATUSES) {
        const tasks = await listTasks(ctx, { ...filter, status: [status], limit: COLUMN_CAP });
        columns.push({ status, tasks: tasks.map(taskRow), capped: tasks.length === COLUMN_CAP });
      }
      return columns;
    },
    (columns: BoardColumn[]) =>
      columns.some((c) => c.tasks.length)
        ? boardText(columns, { rich: term().rich, width: term().width, perColumn })
        : `No tasks. Create one with \`${CLI_NAME} task create "title"\`.`,
  );
}

export const listCommand = defineCommand({
  meta: { name: "list", description: "List tasks" },
  args: {
    status: {
      type: "string",
      description: `Comma-separated: ${TASK_STATUSES.join(", ")}`,
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
    board: {
      type: "boolean",
      description:
        "The board's columns as text; --limit is then the rows shown per column (default 10). Off a terminal, one task per line in column order, and --limit is ignored",
    },
    ...pagination,
    ...json,
  },
  run: ({ args }) => {
    if (args.board) return board(args);
    return execute(
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
      { readOnly: true },
    );
  },
});
