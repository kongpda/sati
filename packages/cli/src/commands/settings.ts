import { readSettings, updateSettings } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, int } from "../runtime.js";

export default defineCommand({
  meta: { name: "settings", description: "Show or change project settings" },
  args: {
    review: { type: "string", description: "agents | all | none" },
    "auto-continue": { type: "boolean", description: "Tell an idle agent to run sati next" },
    "no-auto-continue": { type: "boolean", description: "Turn auto-continue off" },
    lease: { type: "string", description: "Claim lease in minutes" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx, project }) => {
        const changing =
          args.review !== undefined ||
          args["auto-continue"] ||
          args["no-auto-continue"] ||
          args.lease !== undefined;
        if (!changing) return readSettings(project.settings);
        const updated = await updateSettings(ctx, {
          review: args.review,
          autoContinue: args["no-auto-continue"] ? false : args["auto-continue"] ? true : undefined,
          leaseMinutes: int(args.lease, "lease"),
        });
        return readSettings(updated.settings);
      },
      (settings) =>
        `review ${settings.review}\nautoContinue ${settings.autoContinue}\nlease ${settings.leaseMinutes} min`,
    ),
});
