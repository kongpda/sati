import {
  type Decision,
  deleteRecord,
  getRecord,
  listRecords,
  recordDecision,
  resolveId,
  restoreRecord,
} from "@sati/core";
import { defineCommand } from "citty";
import { id, json, pagination } from "../args.js";
import { record, row, rows } from "../render.js";
import { execute, int, ref, refs } from "../runtime.js";

const create = defineCommand({
  meta: { name: "record", description: "Record a decision and why it was made" },
  args: {
    title: { type: "positional", required: true, description: "Decision title" },
    decision: { type: "string", required: true, description: "What was decided" },
    context: { type: "string", description: "The situation that forced the decision" },
    consequences: { type: "string", description: "What follows from it" },
    supersedes: { type: "string", description: "Decision id this one replaces" },
    features: { type: "string", description: "Comma-separated feature ids it affects" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        recordDecision(ctx, {
          title: args.title,
          decision: args.decision,
          context: args.context,
          consequences: args.consequences,
          supersedes: await ref(ctx, "decision", args.supersedes),
          featureIds: await refs(ctx, "feature", args.features),
        }),
      (d: Decision) => `Recorded ${row(d)}`,
    ),
});

const ls = defineCommand({
  meta: { name: "list", description: "List decisions" },
  args: { ...pagination, ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        listRecords(ctx, "decision", {
          limit: int(args.limit, "limit"),
          offset: int(args.offset, "offset"),
        }),
      (items: Decision[]) =>
        rows(items, 'No decisions. Record one with `sati decision record "title" --decision "…"`.'),
    ),
});

const show = defineCommand({
  meta: { name: "show", description: "Show one decision" },
  args: { ...id("Decision"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => getRecord(ctx, "decision", await resolveId(ctx, "decision", args.id)),
      record,
    ),
});

const remove = defineCommand({
  meta: { name: "delete", description: "Soft-delete a decision" },
  args: { ...id("Decision"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        deleteRecord(
          ctx,
          "decision",
          await resolveId(ctx, "decision", args.id),
        ) as Promise<Decision>,
      (d: Decision) => `Deleted ${row(d)}`,
    ),
});

const restore = defineCommand({
  meta: { name: "restore", description: "Restore a soft-deleted decision" },
  args: { ...id("Decision"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        restoreRecord(
          ctx,
          "decision",
          await resolveId(ctx, "decision", args.id),
        ) as Promise<Decision>,
      (d: Decision) => `Restored ${row(d)}`,
    ),
});

export default defineCommand({
  meta: { name: "decision", description: "Log decisions" },
  subCommands: { record: create, list: ls, show, delete: remove, restore },
});
