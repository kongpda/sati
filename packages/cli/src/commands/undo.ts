import { undoActivity } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute } from "../runtime.js";

export default defineCommand({
  meta: {
    name: "undo",
    description: "Revert one activity row if the record has not changed since",
  },
  args: {
    id: { type: "positional", required: true, description: "Activity id" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      ({ ctx }) => undoActivity(ctx, args.id),
      (value) => `Undid\n${JSON.stringify(value, null, 2)}`,
    ),
});
