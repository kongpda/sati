import {
  type Activity,
  listAll,
  SatiError,
  type ServiceContext,
  shortHandle,
  withoutStamps,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { handle } from "../render.js";
import { actorRef, closeRuntime, execute, int, openRuntime, printError, ref } from "../runtime.js";
import { bold, cleanDeep, dim, symbols, table, term, truncate, when } from "../term.js";

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

interface Args {
  actor?: string | undefined;
  task?: string | undefined;
  since?: string | undefined;
  after?: string | undefined;
  limit?: string | undefined;
  follow?: boolean | undefined;
  json?: boolean | undefined;
}

/** The typed filters as the store takes them. Usage errors are thrown here, before any read. */
async function query(ctx: ServiceContext, args: Args) {
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
  return {
    actorId,
    entityId,
    since: at === undefined ? undefined : new Date(at).toISOString(),
    limit,
  };
}

/** Names are for a person's table only; scripts and --json keep the ids. */
async function actorNames(ctx: ServiceContext, into: Map<string, string>): Promise<void> {
  for (const a of await ctx.store.read((r) => listAll(r, ctx, "actor"))) {
    into.set(a.id, a.displayName ?? a.name);
  }
}

function lines(rows: readonly Activity[], names: ReadonlyMap<string, string>): string {
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
}

/** How often `--follow` looks for new rows: the board's event stream uses the same interval. */
const POLL_MS = 250;
/** Rows read at a time while following; a burst larger than this is read in several steps. */
const BATCH = 500;

/**
 * `activity --follow`: the last rows, oldest first, then each new row as it is written, until
 * Ctrl-C. Between writes it only asks SQLite for `PRAGMA data_version`, which moves when another
 * connection commits; the log is read when it moved. A store behind `sati serve` has no such
 * counter here, so it is read once a second.
 */
async function follow(args: Args): Promise<void> {
  const json = args.json ?? false;
  try {
    const { ctx } = await openRuntime();
    const filter = await query(ctx, args);
    const names = new Map<string, string>();
    const rich = !json && term().rich;
    const print = async (found: Activity[]) => {
      if (!found.length) return;
      const rows = json ? found : cleanDeep(found);
      // A new agent may have joined since the names were read.
      if (rich && rows.some((r) => !names.has(r.actorId))) await actorNames(ctx, names);
      process.stdout.write(
        `${json ? rows.map((r) => JSON.stringify(r, withoutStamps)).join("\n") : lines(rows, names)}\n`,
      );
    };
    const read = (after: string | undefined, limit: number) =>
      ctx.store.read((r) => r.listActivity(ctx.projectId, { ...filter, after, limit }));
    // Without a cursor the store answers newest first; a log reads downwards.
    const first = await read(args.after, filter.limit ?? 10);
    if (args.after === undefined) first.reverse();
    let cursor = first.at(-1)?.id ?? args.after;
    await print(first);
    if (rich) process.stderr.write(`${dim("Waiting for new activity. Ctrl-C stops.")}\n`);

    const store = ctx.store;
    const version = () => (store instanceof SqliteStore ? store.dataVersion() : undefined);
    let seen = version();
    let ticks = 0;
    await new Promise<void>((resolve, reject) => {
      let busy = false;
      const stop = () => {
        clearInterval(timer);
        resolve();
      };
      const tick = async () => {
        if (busy) return;
        ticks += 1;
        const now = version();
        if (now === undefined ? ticks % 4 !== 0 : now === seen) return;
        busy = true;
        try {
          for (;;) {
            const rows = await read(cursor, BATCH);
            if (cursor === undefined) rows.reverse();
            cursor = rows.at(-1)?.id ?? cursor;
            await print(rows);
            if (rows.length < BATCH) break;
          }
          seen = now;
        } catch (err) {
          clearInterval(timer);
          reject(err);
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => void tick(), POLL_MS);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } catch (err) {
    process.exitCode = printError(err, json);
  } finally {
    await closeRuntime();
  }
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
    limit: { type: "string", description: "Max rows (default 50, max 500; with --follow, 10)" },
    follow: {
      type: "boolean",
      description:
        "Keep running: print the last rows, then each new row as it is written (Ctrl-C stops)",
    },
    ...json,
  },
  run: ({ args }) => {
    if (args.follow) return follow(args);
    const names = new Map<string, string>();
    return execute(
      args.json,
      async ({ ctx }) => {
        const filter = await query(ctx, args);
        if (!args.json && term().rich) await actorNames(ctx, names);
        return ctx.store.read((r) =>
          r.listActivity(ctx.projectId, { ...filter, after: args.after }),
        );
      },
      (rows: Activity[]) => (rows.length ? lines(rows, names) : "No activity."),
    );
  },
});
