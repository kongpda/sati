import {
  acknowledgeHandoff,
  HANDOFF_TAG,
  listAll,
  type Note,
  resolveId,
  SatiError,
  writeHandoff,
} from "@sati/core";
import { defineCommand } from "citty";
import { id, json } from "../args.js";
import { row } from "../render.js";
import { execute, list } from "../runtime.js";

export default defineCommand({
  meta: { name: "handoff", description: "Leave a where-I-stopped note on a task, or read one" },
  args: {
    ...id("Task"),
    done: { type: "string", description: "What is already done" },
    next: { type: "string", description: "The next step" },
    questions: { type: "string", description: "Open questions" },
    files: { type: "string", description: "Comma-separated files in flight" },
    to: {
      type: "string",
      description: "Who it is for: an actor name or id (default: next claimer)",
    },
    ack: { type: "boolean", description: "Mark the task's handoff read instead of writing one" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) => {
        const taskId = await resolveId(ctx, "task", args.id);
        if (args.ack) {
          const notes = await ctx.store.read((r) => listAll(r, ctx, "note"));
          const note = notes.find((n) => n.tags.includes(HANDOFF_TAG) && n.links.includes(taskId));
          if (!note) throw new SatiError("NOT_FOUND", `Task ${args.id} has no handoff.`);
          return acknowledgeHandoff(ctx, note.id);
        }
        let to: string | undefined;
        if (args.to) {
          const named = await ctx.store.read((r) =>
            r.getByKey("actor", ctx.projectId, args.to ?? ""),
          );
          to = named ? named.id : await resolveId(ctx, "actor", args.to);
        }
        return writeHandoff(ctx, {
          taskId,
          done: args.done,
          next: args.next,
          questions: args.questions,
          files: list(args.files) ?? [],
          to,
        });
      },
      (n: Note) => (args.ack ? `Read ${row(n)}` : `Handoff ${row(n)}`),
    ),
});
