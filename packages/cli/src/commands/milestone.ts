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
import { expectedVersion, id, json, pagination } from "../args.js";
import { record, row, rows } from "../render.js";
import { execute, int } from "../runtime.js";

const create = defineCommand({
  meta: { name: "create", description: "Create a milestone" },
  args: {
    title: { type: "positional", required: true, description: "Milestone title" },
    goal: { type: "string", description: "What done looks like" },
    date: { type: "string", description: "Target date YYYY-MM-DD" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      ({ ctx }) =>
        createMilestone(ctx, { title: args.title, goal: args.goal, targetDate: args.date ?? null }),
      (m: Milestone) => `Created ${row(m)}`,
    ),
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
    ),
});

const update = defineCommand({
  meta: { name: "update", description: "Update a milestone" },
  args: {
    ...id("Milestone"),
    title: { type: "string", description: "New title" },
    goal: { type: "string", description: "What done looks like" },
    date: { type: "string", description: "Target date YYYY-MM-DD" },
    status: {
      type: "string",
      description: "planned | active | done (planned and done change through active)",
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
          targetDate: args.date,
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
