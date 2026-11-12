import { CLI_NAME, readSettings, renameProject, updateSettings } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { readProjects, rememberProject } from "../projects.js";
import { pairs } from "../render.js";
import { execute, int, writeConfigKind } from "../runtime.js";
import { term } from "../term.js";

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
    name: { type: "string", description: "Rename the project (people only)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx, project, location }) => {
        const named =
          args.name === undefined
            ? project
            : await renameProject(ctx, { name: args.name }).then((p) => {
                renameKnown(p.id, p.name);
                return p;
              });
        const changing =
          args.review !== undefined ||
          args["auto-continue"] !== undefined ||
          args.lease !== undefined ||
          args.kind !== undefined;
        if (!changing) return { name: named.name, ...readSettings(named.settings) };
        const updated = await updateSettings(ctx, {
          review: args.review,
          autoContinue: args["auto-continue"],
          leaseMinutes: int(args.lease, "lease"),
          kind: args.kind,
        });
        const settings = readSettings(updated.settings);
        writeConfigKind(location.root, settings.kind);
        return { name: named.name, ...settings };
      },
      (settings) => {
        const fields: [string, string][] = [
          ["name", settings.name],
          ["kind", settings.kind],
          ["review", settings.review],
          ["autoContinue", String(settings.autoContinue)],
          ["lease", `${settings.leaseMinutes} min`],
        ];
        return term().rich
          ? pairs(fields, term().width).join("\n")
          : fields.map(([k, v]) => `${k} ${v}`).join("\n");
      },
    ),
});

/** Keeps the name in this machine's project list in step, so `projects` shows the new one. */
function renameKnown(projectId: string, name: string): void {
  const known = readProjects().find((p) => p.projectId === projectId);
  if (known && known.name !== name) rememberProject({ ...known, name });
}
