import {
  addComment,
  CLI_NAME,
  commentTarget,
  listAll,
  listComments,
  type Note,
  SatiError,
  shortHandle,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { askText, canAsk, missing, pickTask, sameAs } from "../prompt.js";
import { bodyText } from "../runtime/input.js";
import { execute } from "../runtime/output.js";
import { bold, dim, LISTED, term, when, wrap, yellow } from "../term.js";

/** One comment: UTC time, author's name, and the body indented under it. */
const line = (n: Note, names: Map<string, string>) => {
  const who = names.get(n.createdBy) ?? shortHandle(n.createdBy);
  const tag = n.tags.includes("handoff") ? "  handoff" : "";
  if (!term().rich) {
    return `${n.createdAt.slice(0, 16).replace("T", " ")}Z  ${who}${tag}\n  ${n.body.split("\n").join("\n  ")}`;
  }
  const body = wrap(n.body, Math.min(term().width, 120) - 2).replace(/^/gmu, "  ");
  return `${bold(who)}  ${dim(when(n.createdAt))}${yellow(tag)}\n${body}`;
};

const add = defineCommand({
  meta: { name: "add", description: "Comment on a task, note or decision" },
  args: {
    on: {
      type: "positional",
      required: false,
      description:
        "Task, note or decision id or handle (at a terminal: leave it out to choose a task)",
    },
    body: {
      type: "positional",
      required: false,
      description: "The comment, in Markdown (- reads stdin; at a terminal: asked when left out)",
    },
    ...json,
  },
  run: ({ args }) => {
    if (!canAsk(args.json)) {
      if (args.on === undefined) throw missing("on", "comment add");
      // One word given: it was read as the record, which is rarely what was meant.
      if (args.body === undefined) {
        throw new SatiError("USAGE", `Missing <body>: ${CLI_NAME} comment add <on> <body>`, {
          hint: `The first word is the record to comment on. Run \`${CLI_NAME} comment add --help\` for usage.`,
        });
      }
    }
    return execute(
      args.json,
      async ({ ctx }) => {
        const on =
          args.on === undefined
            ? await pickTask(ctx, {}, "Comment on which task?", {
                empty: new SatiError("NOT_FOUND", "No tasks to comment on.", {
                  hint: `A note or decision takes its id: \`${CLI_NAME} comment add <id> "text"\`.`,
                }),
              })
            : await commentTarget(ctx, args.on);
        const body = args.body === undefined ? await askText("Comment") : bodyText(args.body);
        if (args.body === undefined) sameAs("comment", "add", shortHandle(on), body ?? "");
        return addComment(ctx, { on, body: body ?? "" });
      },
      (n: Note) => `Commented on ${shortHandle(n.links[0] ?? "")} (${shortHandle(n.id)})`,
    );
  },
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
          ? term().rich
            ? `${LISTED}${items.map((n) => line(n, names)).join("\n\n")}`
            : items.map((n) => line(n, names)).join("\n")
          : `No comments. Add one with \`${CLI_NAME} comment add ${args.on} "text"\`.`,
      { readOnly: true },
    );
  },
});

export default defineCommand({
  meta: { name: "comment", description: "Comment on tasks, notes and decisions" },
  subCommands: { add, list: ls },
});
