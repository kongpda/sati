import {
  acknowledgeHandoff,
  CLI_NAME,
  HANDOFF_TAG,
  listAll,
  type Note,
  resolveActor,
  SatiError,
  shortHandle,
  writeHandoff,
} from "@sati/core";
import { defineCommand } from "citty";
import { json, taskId } from "../args.js";
import { row } from "../render.js";
import { execute, heldTask, list } from "../runtime.js";

export default defineCommand({
  meta: {
    name: "handoff",
    description: "Leave a where-I-stopped note on a task, or read it (no flags)",
  },
  args: {
    ...taskId,
    done: { type: "string", description: "What is already done" },
    next: { type: "string", description: "The next step" },
    questions: { type: "string", description: "Open questions" },
    files: { type: "string", description: "Comma-separated files in flight" },
    to: {
      type: "string",
      description: "Who it is for: an actor name or id (default: next claimer)",
    },
    ack: {
      type: "boolean",
      description:
        "Mark the task's handoff read instead of writing one (wins over the other flags)",
    },
    ...json,
  },
  run: ({ args }) => {
    const writing = [args.done, args.next, args.questions, args.files, args.to].some(
      (v) => v !== undefined,
    );
    return execute(
      args.json,
      async ({ ctx }) => {
        const taskId = await heldTask(ctx, args.id);
        const shown = args.id ?? shortHandle(taskId);
        // With nothing to write, read the handoff: an empty write would wipe the last one.
        if (args.ack || !writing) {
          const notes = await ctx.store.read((r) => listAll(r, ctx, "note"));
          const note = notes.find((n) => n.tags.includes(HANDOFF_TAG) && n.links.includes(taskId));
          if (!note) {
            throw new SatiError("NOT_FOUND", `Task ${shown} has no handoff.`, {
              hint: `Write one with \`${CLI_NAME} handoff ${shown} --done "..." --next "..."\`.`,
            });
          }
          return args.ack ? acknowledgeHandoff(ctx, note.id) : note;
        }
        const to = args.to ? await resolveActor(ctx, args.to) : undefined;
        return writeHandoff(ctx, {
          taskId,
          done: args.done,
          next: args.next,
          questions: args.questions,
          files: list(args.files) ?? [],
          to,
        });
      },
      (n: Note) => {
        if (args.ack) return `Read ${row(n)}`;
        return writing ? `Handoff ${row(n)}` : `${row(n)}\n\n${n.body}`;
      },
    );
  },
});
