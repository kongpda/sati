import {
  CLI_NAME,
  createMilestone,
  getRecord,
  listRecords,
  type Milestone,
  resolveId,
  updateMilestone,
} from "@sati/core";
import { defineCommand } from "citty";
import { expectedVersion, id, json, orNone, pagination } from "../args.js";
import { askText, canAsk, missing, sameAs } from "../prompt.js";
import { record, row, rows } from "../render.js";
import { int } from "../runtime/input.js";
import { execute } from "../runtime/output.js";
import { typedAfter } from "./task/shared.js";

const create = defineCommand({
  meta: { name: "create", description: "Create a milestone" },
  args: {
    title: {
      type: "positional",
      required: false,
      description: "Milestone title (at a terminal: asked when left out)",
    },
    goal: { type: "string", description: "What done looks like" },
    due: { type: "string", alias: "date", description: "Target date YYYY-MM-DD" },
    ...json,
  },
  run: ({ args }) => {
    if (args.title === undefined && !canAsk(args.json)) throw missing("title", "milestone create");
    return execute(
      args.json,
      async ({ ctx }) => {
        const title = args.title ?? (await askText("Milestone title"));
        if (args.title === undefined) {
          sameAs("milestone", "create", title, ...typedAfter("create"));
        }
        return createMilestone(ctx, { title, goal: args.goal, targetDate: args.due ?? null });
      },
      (m: Milestone) => `Created ${row(m)}`,
    );
  },
});

const ls = defineCommand({
  meta: { name: "list", description: "List milestones" },
  args: { ...pagination, ...json },
  run: ({ args }) =>
    execute(
      args.json,
      ({ ctx }) =>
        listRecords(ctx, "milestone", {
          limit: int(args.limit, "limit"),
          offset: int(args.offset, "offset"),
        }),
      (items: Milestone[]) =>
        rows(items, `No milestones. Create one with \`${CLI_NAME} milestone create\`.`),
      { readOnly: true },
    ),
});

const show = defineCommand({
  meta: { name: "show", description: "Show one milestone" },
  args: { ...id("Milestone"), ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => getRecord(ctx, "milestone", await resolveId(ctx, "milestone", args.id)),
      record,
      { readOnly: true },
    ),
});

const update = defineCommand({
  meta: { name: "update", description: "Update a milestone" },
  args: {
    ...id("Milestone"),
    title: { type: "string", description: "New title" },
    goal: { type: "string", description: "What done looks like" },
    due: {
      type: "string",
      alias: "date",
      description: "Target date YYYY-MM-DD, or none to clear",
    },
    status: {
      type: "string",
      description:
        "planned | active | done | cancelled (planned and done change through active; cancelled reopens as planned)",
    },
    ...expectedVersion,
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        updateMilestone(ctx, await resolveId(ctx, "milestone", args.id), {
          title: args.title,
          goal: args.goal,
          targetDate: orNone(args.due),
          status: args.status,
          expectedVersion: int(args["expected-version"], "expected-version"),
        }),
      (m: Milestone) => `Updated ${row(m)}`,
    ),
});

export default defineCommand({
  meta: { name: "milestone", description: "Roadmap milestones" },
  subCommands: { create, list: ls, show, update },
});
