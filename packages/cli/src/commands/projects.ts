import { listTasks, systemClock } from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { readProjects } from "../projects.js";
import { output } from "../runtime.js";

export default defineCommand({
  meta: { name: "projects", description: "Projects this machine knows" },
  args: { ...json },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        const known = readProjects();
        const rows = [];
        for (const project of known) {
          let ready = 0;
          let inProgress = 0;
          let review = 0;
          try {
            const store = await SqliteStore.open(project.db);
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
            await store.close();
          } catch {
            ready = -1;
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
          : "No projects yet. Run `sati init`.",
    ),
});
