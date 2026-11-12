import {
  CLI_NAME,
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
import { askBody, askText, canAsk, missing, missingFlag, sameAs } from "../prompt.js";
import { record, row, rows } from "../render.js";
import { execute, int, ref, refs } from "../runtime.js";

const create = defineCommand({
  meta: { name: "record", description: "Record a decision and why it was made" },
  args: {
    title: {
      type: "positional",
      required: false,
      description: "Decision title (at a terminal: asked when left out)",
    },
    decision: {
      type: "string",
      description: "What was decided (required; at a terminal: asked when left out)",
    },
    context: { type: "string", description: "The situation that forced the decision" },
    consequences: { type: "string", description: "What follows from it" },
    supersedes: { type: "string", description: "Decision id this one replaces" },
    features: { type: "string", description: "Comma-separated feature ids it affects" },
    ...json,
  },
  run: ({ args }) => {
    if (!canAsk(args.json)) {
      if (args.title === undefined) throw missing("title", "decision record");
      if (args.decision === undefined) throw missingFlag("decision", "decision record");
    }
    return execute(
      args.json,
      async ({ ctx }) => {
        const title = args.title ?? (await askText("Decision title"));
        // The decision itself is often a paragraph: the editor when one is set, else one line.
        const decision = args.decision ?? (await askBody("What was decided?"));
        if (args.title === undefined || args.decision === undefined) {
          const argv = process.argv.slice(2);
          const flags = argv.slice(argv.indexOf("record") + 1).filter((w) => w !== args.title);
          sameAs(
            "decision",
            "record",
            title,
            ...(args.decision === undefined ? ["--decision", decision] : []),
            ...flags,
          );
        }
        return recordDecision(ctx, {
          title,
          decision,
          context: args.context,
          consequences: args.consequences,
          supersedes: await ref(ctx, "decision", args.supersedes),
          featureIds: await refs(ctx, "feature", args.features),
        });
      },
      (d: Decision) => `Recorded ${row(d)}`,
    );
  },
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
        rows(
          items,
          `No decisions. Record one with \`${CLI_NAME} decision record "title" --decision "…"\`.`,
        ),
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
          await resolveId(ctx, "decision", args.id, { deleted: true }),
        ) as Promise<Decision>,
      (d: Decision) => `Restored ${row(d)}`,
    ),
});

export default defineCommand({
  meta: { name: "decision", description: "Log decisions" },
  subCommands: { record: create, list: ls, show, delete: remove, restore },
});
