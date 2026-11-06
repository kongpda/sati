import type { Activity } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute, int, ref } from "../runtime.js";

export default defineCommand({
  meta: { name: "activity", description: "Show the audit log" },
  args: {
    actor: { type: "string", description: "Actor id or name" },
    task: { type: "string", description: "Task id or handle" },
    since: { type: "string", description: "UTC time, inclusive" },
    limit: { type: "string", description: "Max rows (default 50)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const entityId = await ref(ctx, "task", args.task);
        let actorId = args.actor;
        if (actorId && !actorId.startsWith("actr_")) {
          const actors = await ctx.store.read((r) =>
            r.list("actor", ctx.projectId, { limit: 200 }),
          );
          actorId = actors.find((a) => a.name === args.actor)?.id ?? actorId;
        }
        return ctx.store.read((r) =>
          r.listActivity(ctx.projectId, {
            actorId,
            entityId,
            since: args.since,
            limit: int(args.limit, "limit"),
          }),
        );
      },
      (rows: Activity[]) =>
        rows.length
          ? rows
              .map((row) => {
                const diff = Object.keys(row.diff).length ? ` ${JSON.stringify(row.diff)}` : "";
                return `${row.at} ${row.actorId} ${row.verb} ${row.entity} ${row.entityId}${diff}`;
              })
              .join("\n")
          : "No activity.",
    ),
});
