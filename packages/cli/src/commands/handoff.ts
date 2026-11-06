import { type Note, resolveId, writeHandoff } from "@sati/core";
import { defineCommand } from "citty";
import { id, json } from "../args.js";
import { row } from "../render.js";
import { execute, list } from "../runtime.js";

export default defineCommand({
  meta: { name: "handoff", description: "Leave a where-I-stopped note on a task" },
  args: {
    ...id("Task"),
    done: { type: "string", description: "What is already done" },
    next: { type: "string", description: "The next step" },
    questions: { type: "string", description: "Open questions" },
    files: { type: "string", description: "Comma-separated files in flight" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx }) =>
        writeHandoff(ctx, {
          taskId: await resolveId(ctx, "task", args.id),
          done: args.done,
          next: args.next,
          questions: args.questions,
          files: list(args.files) ?? [],
        }),
      (n: Note) => `Handoff ${row(n)}`,
    ),
});
