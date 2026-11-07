import {
  addComment,
  CLI_NAME,
  commentTarget,
  listAll,
  listComments,
  type Note,
  shortHandle,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute } from "../runtime.js";

/** One comment: UTC time, author's name, and the body indented under it. */
const line = (n: Note, names: Map<string, string>) =>
  `${n.createdAt.slice(0, 16).replace("T", " ")}Z  ${names.get(n.createdBy) ?? shortHandle(n.createdBy)}${n.tags.includes("handoff") ? "  handoff" : ""}\n  ${n.body.split("\n").join("\n  ")}`;

const add = defineCommand({
  meta: { name: "add", description: "Comment on a task, note or decision" },
  args: {
    on: { type: "positional", required: true, description: "Task, note or decision id or handle" },
    body: { type: "positional", required: true, description: "The comment, in Markdown" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        addComment(ctx, { on: await commentTarget(ctx, args.on), body: args.body }),
      (n: Note) => `Commented on ${shortHandle(n.links[0] ?? "")} (${shortHandle(n.id)})`,
    ),
});

const ls = defineCommand({
  meta: { name: "list", description: "Show the comments and handoffs on a record, oldest first" },
  args: {
    on: { type: "positional", required: true, description: "Task, note or decision id or handle" },
    ...json,
  },
  run: ({ args }) => {
    const names = new Map<string, string>();
    return execute(
      args.json,
      async ({ ctx }) => {
        const items = await listComments(ctx, await commentTarget(ctx, args.on));
        for (const a of await ctx.store.read((r) => listAll(r, ctx, "actor"))) {
          names.set(a.id, a.displayName ?? a.name);
        }
        return items;
      },
      (items: Note[]) =>
        items.length
          ? items.map((n) => line(n, names)).join("\n")
          : `No comments. Add one with \`${CLI_NAME} comment add ${args.on} "text"\`.`,
    );
  },
});

export default defineCommand({
  meta: { name: "comment", description: "Comment on tasks, notes and decisions" },
  subCommands: { add, list: ls },
});
