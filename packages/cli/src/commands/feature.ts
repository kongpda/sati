import {
  CLI_NAME,
  createFeature,
  type Feature,
  featureList,
  getRecord,
  listRecords,
  resolveId,
  SatiError,
  updateFeature,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, pagination } from "../args.js";
import { record, row, rows } from "../render.js";
import { execute, int, list, ref } from "../runtime.js";

const fields = {
  description: { type: "string", description: "What the feature does, in Markdown" },
  status: { type: "string", description: "planned | building | shipped | deprecated | removed" },
  milestone: { type: "string", description: "Milestone id or handle" },
  paths: { type: "string", description: "Comma-separated path globs the feature owns" },
  tests: { type: "string", description: "Comma-separated test path globs" },
  acceptance: { type: "string", description: "Comma-separated acceptance criteria" },
  protected: {
    type: "boolean",
    description: "Guard the feature's paths against edits (--no-protected turns it off)",
  },
} as const;

const create = defineCommand({
  meta: { name: "create", description: "Create a feature" },
  args: {
    title: { type: "positional", required: true, description: "Feature title" },
    ...fields,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        createFeature(ctx, {
          title: args.title,
          description: args.description,
          status: args.status,
          milestoneId: await ref(ctx, "milestone", args.milestone),
          paths: list(args.paths),
          tests: list(args.tests),
          acceptance: list(args.acceptance),
          protected: args.protected,
        }),
      (f: Feature) => `Created ${row(f)}`,
    ),
});

const ls = defineCommand({
  meta: { name: "list", description: "List features" },
  args: {
    status: {
      type: "string",
      description: "Comma-separated: planned, building, shipped, deprecated, removed",
    },
    milestone: { type: "string", description: "Only features of this milestone" },
    md: {
      type: "boolean",
      description:
        "What the product does today as Markdown: shipped features, acceptance criteria, milestone; ignores the filters",
    },
    // Kept for old scripts: `--format md` is `--md` (hidden, review 7.9).
    format: { type: "string", description: "Old form of --md: md is the only value" },
    ...pagination,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }): Promise<string | Feature[]> => {
        if (args.md || args.format === "md") return featureList(ctx);
        if (args.format !== undefined) {
          throw new SatiError("USAGE", `Unknown format "${args.format}".`, {
            hint: "Use --md, or leave it out for the list.",
          });
        }
        return listRecords(ctx, "feature", {
          status: list(args.status),
          milestoneId: await ref(ctx, "milestone", args.milestone),
          limit: int(args.limit, "limit"),
          offset: int(args.offset, "offset"),
        });
      },
      (out) =>
        typeof out === "string"
          ? out.trimEnd()
          : rows(out, `No features. Create one with \`${CLI_NAME} feature create "title"\`.`),
    ),
});

const show = defineCommand({
  meta: { name: "show", description: "Show one feature" },
  args: { ...id("Feature"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => getRecord(ctx, "feature", await resolveId(ctx, "feature", args.id)),
      record,
    ),
});

const update = defineCommand({
  meta: { name: "update", description: "Change a feature" },
  args: {
    ...id("Feature"),
    title: { type: "string", description: "New title" },
    ...fields,
    decision: { type: "string", description: "Decision id that justifies removing the feature" },
    reviewed: { type: "boolean", description: "Clear needsReview" },
    ...expectedVersion,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        updateFeature(ctx, await resolveId(ctx, "feature", args.id), {
          title: args.title,
          description: args.description,
          status: args.status,
          milestoneId: await ref(ctx, "milestone", args.milestone),
          paths: list(args.paths),
          tests: list(args.tests),
          acceptance: list(args.acceptance),
          protected: args.protected,
          decisionId: await ref(ctx, "decision", args.decision),
          reviewed: args.reviewed ? true : undefined,
          expectedVersion: int(args["expected-version"], "expected-version"),
        }),
      (f: Feature) => `Updated ${row(f)}`,
    ),
});

export default defineCommand({
  meta: { name: "feature", description: "Track features and what they own" },
  subCommands: { create, list: ls, show, update },
});
