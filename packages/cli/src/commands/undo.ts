import { shortHandle, undoActivity } from "@sati/core";
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
      (value) => {
        // The whole record is in `--json`; a person needs to know which record went back.
        const r = value as { id?: unknown; title?: unknown; deletedAt?: unknown };
        const name = typeof r.title === "string" ? ` ${r.title}` : "";
        const what = typeof r.id === "string" ? ` ${shortHandle(r.id)}${name}` : "";
        return `Undid ${args.id}:${what}${r.deletedAt ? " (now deleted)" : ""}`.replace(/:$/u, ".");
      },
    ),
});
