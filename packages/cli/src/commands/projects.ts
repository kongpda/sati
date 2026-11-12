import { CLI_NAME, listTasks, SatiError, systemClock } from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { forgetProject, pruneProjects, readProjects } from "../projects.js";
import { Cancelled, canAsk } from "../prompt.js";
import { output } from "../runtime.js";
import { bold, dim, red, table, term, tilde } from "../term.js";

const forget = defineCommand({
  meta: {
    name: "forget",
    description:
      "Remove a project from this machine's list. The folder and the database stay where they are",
  },
  args: {
    project: { type: "positional", description: "Slug or folder of the project", required: true },
    yes: { type: "boolean", description: "Do not ask for confirmation" },
    ...json,
  },
  run: ({ args }) =>
    output(
      args.json,
      async () => {
        const ref = String(args.project);
        const known = readProjects().find((p) => p.slug === ref);
        if (!args.yes) {
          if (!canAsk(args.json)) {
            throw new SatiError("USAGE", "projects forget needs --yes when it cannot ask.", {
              hint: `Run \`${CLI_NAME} projects forget ${ref} --yes\`.`,
            });
          }
          const clack = await import("@clack/prompts");
          const ok = await clack.confirm({
            message: `Forget ${known?.slug ?? ref}? Its folder and database are kept.`,
            initialValue: false,
          });
          if (clack.isCancel(ok) || ok !== true) throw new Cancelled();
        }
        const gone = forgetProject(ref);
        if (!gone) {
          throw new SatiError("NOT_FOUND", `No project named ${ref} on this machine.`, {
            hint: `Run \`${CLI_NAME} projects\` to see them.`,
          });
        }
        return gone;
      },
      (gone) => `Forgot ${gone.slug}. The folder ${tilde(gone.root)} and its database are kept.`,
    ),
});

export default defineCommand({
  meta: {
    name: "projects",
    description:
      "Projects this machine knows. Add `--project <slug>` (or the folder's full path) to any command to run it against one",
  },
  args: {
    prune: {
      type: "boolean",
      description: "First forget projects whose folder or database is gone",
    },
    ...json,
  },
  subCommands: { forget },
  // citty runs this after a subcommand too, so it stops when `forget` was the one asked for.
  run: ({ args }) =>
    args._[0] === "forget"
      ? undefined
      : output(
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
          (rows) => {
            if (rows.length && term().rich) {
              const head = ["PROJECT", "READY", "DOING", "REVIEW", "FOLDER"].map(dim);
              const body = rows.map((p) =>
                p.ready < 0
                  ? [bold(p.slug), red("?"), red("?"), red("?"), tilde(p.root)]
                  : [
                      bold(p.slug),
                      String(p.ready),
                      String(p.inProgress),
                      String(p.review),
                      tilde(p.root),
                    ],
              );
              const broken = rows.filter((p) => p.ready < 0).length;
              return [
                table([head, ...body], { flex: 4, paint: dim }),
                ...(broken
                  ? [
                      "",
                      `${broken} with no readable database. \`${CLI_NAME} projects --prune\` forgets them.`,
                    ]
                  : []),
              ].join("\n");
            }
            return rows.length
              ? rows
                  .map((p) =>
                    // `ready` is -1 in JSON when the database did not open. A person gets the reason.
                    p.ready < 0
                      ? `${p.slug}  database not readable, \`${CLI_NAME} projects --prune\` forgets it  ${p.root}`
                      : `${p.slug}  ready ${p.ready}  in_progress ${p.inProgress}  review ${p.review}  ${p.root}`,
                  )
                  .join("\n")
              : `No projects yet. Run \`${CLI_NAME} init\`.`;
          },
        ),
});
