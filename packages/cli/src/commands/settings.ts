import { CLI_NAME, readSettings, updateSettings } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, int, writeConfigKind } from "../runtime.js";

export default defineCommand({
  meta: { name: "settings", description: "Show project settings, or change them with flags" },
  args: {
    review: {
      type: "string",
      description: "Whose finished tasks wait for approval: agents (default) | all | none",
    },
    // citty reads `--no-auto-continue` as `auto-continue: false`, so no separate flag is declared.
    "auto-continue": {
      type: "boolean",
      description: `Tell an idle agent to run ${CLI_NAME} next (--no-auto-continue turns it off)`,
    },
    lease: { type: "string", description: "Claim lease in minutes (1-1440, default 30)" },
    kind: {
      type: "string",
      description: "code | general (general hides features, file locks and the guard)",
    },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx, project, location }) => {
        const changing =
          args.review !== undefined ||
          args["auto-continue"] !== undefined ||
          args.lease !== undefined ||
          args.kind !== undefined;
        if (!changing) return readSettings(project.settings);
        const updated = await updateSettings(ctx, {
          review: args.review,
          autoContinue: args["auto-continue"],
          leaseMinutes: int(args.lease, "lease"),
          kind: args.kind,
        });
        const settings = readSettings(updated.settings);
        writeConfigKind(location.root, settings.kind);
        return settings;
      },
      (settings) =>
        `kind ${settings.kind}\nreview ${settings.review}\nautoContinue ${settings.autoContinue}\nlease ${settings.leaseMinutes} min`,
    ),
});
