import { deleteRecord, resolveId, restoreRecord, type Task } from "@sati/core";
import { defineCommand } from "citty";
import { id, json } from "../../args.js";
import { row } from "../../render.js";
import { execute } from "../../runtime/output.js";

export const removeCommand = defineCommand({
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

export const restoreCommand = defineCommand({
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
