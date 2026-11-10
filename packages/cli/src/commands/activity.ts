import type { Activity } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { actorRef, execute, int, ref } from "../runtime.js";

export default defineCommand({
  meta: { name: "activity", description: "Show the audit log" },
  args: {
    actor: { type: "string", description: "Actor id or name" },
    task: { type: "string", description: "Task id or handle" },
    since: { type: "string", description: "UTC time (ISO 8601), inclusive" },
    after: {
      type: "string",
      description: "Only rows written after this activity id, oldest first (a cursor)",
    },
    limit: { type: "string", description: "Max rows (default 50, max 500)" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const entityId = await ref(ctx, "task", args.task);
        const actorId = await actorRef(ctx, args.actor);
        return ctx.store.read((r) =>
          r.listActivity(ctx.projectId, {
            actorId,
            entityId,
            since: args.since,
            after: args.after,
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
