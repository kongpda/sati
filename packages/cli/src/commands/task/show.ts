import { getRecord, shortHandle } from "@sati/core";
import { defineCommand } from "citty";
import { json, taskId } from "../../args.js";
import { canAsk, pickTask, sameAs } from "../../prompt.js";
import { record } from "../../render.js";
import { heldTask } from "../../runtime/input.js";
import { execute } from "../../runtime/output.js";
import { noTasks } from "./shared.js";

export const showCommand = defineCommand({
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
      { readOnly: true },
    ),
});
