import { CLI_NAME, readSettings, updateSettings } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, int } from "../runtime.js";

export default defineCommand({
  meta: { name: "settings", description: "Show or change project settings" },
  args: {
    review: { type: "string", description: "agents | all | none" },
    // citty reads `--no-auto-continue` as `auto-continue: false`, so no separate flag is declared.
    "auto-continue": {
      type: "boolean",
      description: `Tell an idle agent to run ${CLI_NAME} next (--no-auto-continue turns it off)`,
    },
    lease: { type: "string", description: "Claim lease in minutes" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx, project }) => {
        const changing =
          args.review !== undefined ||
          args["auto-continue"] !== undefined ||
          args.lease !== undefined;
        if (!changing) return readSettings(project.settings);
        const updated = await updateSettings(ctx, {
          review: args.review,
          autoContinue: args["auto-continue"],
          leaseMinutes: int(args.lease, "lease"),
        });
        return readSettings(updated.settings);
      },
      (settings) =>
        `review ${settings.review}\nautoContinue ${settings.autoContinue}\nlease ${settings.leaseMinutes} min`,
    ),
});
