import { createTask, type Task } from "@sati/core";
import { defineCommand } from "citty";
import { json, orNone } from "../../args.js";
import { askSelect, askText, canAsk, missing, sameAs } from "../../prompt.js";
import { row } from "../../render.js";
import { bodyText, list, parseJson } from "../../runtime/input.js";
import { execute } from "../../runtime/output.js";
import { assignees, depends, fields, link, typedAfter } from "./shared.js";

export const createCommand = defineCommand({
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
