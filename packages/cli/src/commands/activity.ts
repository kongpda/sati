import { type Activity, listAll, SatiError, shortHandle } from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { handle } from "../render.js";
import { actorRef, execute, int, ref } from "../runtime.js";
import { bold, dim, symbols, table, term, truncate, when } from "../term.js";

const brief = (v: unknown): string =>
  v === null || v === undefined
    ? "none"
    : typeof v === "object"
      ? Array.isArray(v)
        ? `${v.length} item${v.length === 1 ? "" : "s"}`
        : "…"
      : truncate(String(v).replace(/\s+/gu, " "), 40);

/** What a write changed, in words: `status todo → in_progress, branch none → main`. */
function changed(diff: Record<string, unknown>): string {
  const arrow = symbols().arrow;
  return Object.entries(diff)
    .map(([k, v]) => {
      const move = v as { from?: unknown; to?: unknown } | null;
      return move !== null && typeof move === "object" && "from" in move && "to" in move
        ? `${k} ${brief(move.from)} ${arrow} ${brief(move.to)}`
        : `${k} ${brief(v)}`;
    })
    .join(", ");
}

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
  run: ({ args }) => {
    const names = new Map<string, string>();
    return execute(
      args.json,
      async ({ ctx }) => {
        const entityId = await ref(ctx, "task", args.task);
        const actorId = await actorRef(ctx, args.actor);
        // The store compares text: a time it cannot read would match nothing, or everything.
        const at = args.since === undefined ? undefined : Date.parse(args.since);
        if (at !== undefined && Number.isNaN(at)) {
          throw new SatiError("USAGE", `--since must be a time, got "${args.since}".`, {
            hint: "Use a day or a UTC time: 2026-01-31 or 2026-01-31T09:00:00Z.",
          });
        }
        const limit = int(args.limit, "limit");
        if (limit !== undefined && limit < 1) {
          throw new SatiError("USAGE", `--limit must be 1 or more, got ${limit}.`);
        }
        // Names are for a person's table only; scripts and --json keep the ids.
        if (!args.json && term().rich) {
          for (const a of await ctx.store.read((r) => listAll(r, ctx, "actor"))) {
            names.set(a.id, a.displayName ?? a.name);
          }
        }
        return ctx.store.read((r) =>
          r.listActivity(ctx.projectId, {
            actorId,
            entityId,
            since: at === undefined ? undefined : new Date(at).toISOString(),
            after: args.after,
            limit,
          }),
        );
      },
      (rows: Activity[]) => {
        if (!rows.length) return "No activity.";
        if (!term().rich) {
          return rows
            .map((row) => {
              const diff = Object.keys(row.diff).length ? ` ${JSON.stringify(row.diff)}` : "";
              return `${row.at} ${row.actorId} ${row.verb} ${row.entity} ${row.entityId}${diff}`;
            })
            .join("\n");
        }
        return table(
          rows.map((row) => [
            dim(when(row.at)),
            truncate(names.get(row.actorId) ?? shortHandle(row.actorId), 28),
            bold(row.verb),
            handle(row.entityId),
            changed(row.diff),
          ]),
          { flex: 4, paint: dim },
        );
      },
    );
  },
});
