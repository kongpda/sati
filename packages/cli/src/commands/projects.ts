import { CLI_NAME, listTasks, systemClock } from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { pruneProjects, readProjects } from "../projects.js";
import { output } from "../runtime.js";

export default defineCommand({
  meta: {
    name: "projects",
    description:
      "Projects this machine knows. Add `--project <slug>` to any command to run it against one",
  },
  args: {
    prune: {
      type: "boolean",
      description: "First forget projects whose folder or database is gone",
    },
    ...json,
  },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        if (args.prune) {
          // On stderr, so `--json` keeps its shape: the list of remaining projects.
          const gone = pruneProjects();
          process.stderr.write(
            `Forgot ${gone.length} ${gone.length === 1 ? "project" : "projects"} whose folder or database is gone.\n`,
          );
        }
        const known = readProjects();
        const rows = [];
        for (const project of known) {
          let ready = 0;
          let inProgress = 0;
          let review = 0;
          let store: SqliteStore | undefined;
          try {
            // Read-only: opening for writing creates an empty database where one is missing,
            // and `--prune` then takes the project for a live one.
            store = await SqliteStore.open(project.db, { readonly: true });
            const now = systemClock.now().toISOString();
            const ctx = {
              store,
              clock: systemClock,
              ids: () => "",
              projectId: project.projectId,
              actorId: "",
              branch: null,
            };
            const tasks = await listTasks(ctx, { limit: 500 });
            ready = (await store.read((r) => r.readyTasks(project.projectId, now, 500))).length;
            inProgress = tasks.filter((t) => t.status === "in_progress").length;
            review = tasks.filter((t) => t.status === "review").length;
          } catch {
            ready = -1;
          } finally {
            await store?.close();
          }
          rows.push({ ...project, ready, inProgress, review });
        }
        return rows;
      },
      (rows) =>
        rows.length
          ? rows
              .map(
                (p) =>
                  `${p.slug}  ready ${p.ready}  in_progress ${p.inProgress}  review ${p.review}  ${p.root}`,
              )
              .join("\n")
          : `No projects yet. Run \`${CLI_NAME} init\`.`,
    ),
});
