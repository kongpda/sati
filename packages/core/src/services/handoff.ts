import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { LIMITS } from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import { listAll, mustGet, parseInput, type ServiceContext } from "./context.js";
import { createNote, updateNote } from "./note.js";

export const HANDOFF_TAG = "handoff";

export const HandoffInput = z.strictObject({
  taskId: z.string().trim().min(1),
  done: z.string().max(LIMITS.body).default(""),
  next: z.string().max(LIMITS.shortText).default(""),
  questions: z.string().max(LIMITS.body).default(""),
  files: z.array(z.string().min(1).max(LIMITS.path)).max(LIMITS.array).default([]),
});
export type HandoffInput = z.input<typeof HandoffInput>;

export function handoffBody(input: {
  done: string;
  next: string;
  questions: string;
  files: readonly string[];
}): string {
  const files = input.files.length ? input.files.map((f) => `- ${f}`).join("\n") : "- none";
  return [
    "## Done so far",
    input.done || "Nothing recorded.",
    "",
    "## Next step",
    input.next || "Not set.",
    "",
    "## Open questions",
    input.questions || "None.",
    "",
    "## Files in flight",
    files,
  ].join("\n");
}

/** The next-step section, for the brief. Empty when the note is not a handoff. */
export function handoffNext(body: string): string {
  const match = body.match(/## Next step\n([\s\S]*?)(?:\n## |$)/);
  return match?.[1]?.trim() ?? "";
}

/** Writes or replaces the handoff note linked to a task. One note per task. */
export async function writeHandoff(ctx: ServiceContext, input: unknown) {
  const data = parseInput(HandoffInput, input);
  const task = await ctx.store.read((r) => mustGet(r, ctx, "task", data.taskId));
  const body = handoffBody(data);
  const existing = await ctx.store.read(async (r) =>
    (await listAll(r, ctx, "note")).find(
      (n) => n.tags.includes(HANDOFF_TAG) && n.links.includes(task.id),
    ),
  );
  if (!existing) {
    return createNote(ctx, {
      title: `Handoff ${task.title}`.slice(0, LIMITS.title),
      body,
      tags: [HANDOFF_TAG],
      links: [task.id],
    });
  }
  return updateNote(ctx, existing.id, { body, expectedVersion: existing.version });
}

export function missingTask(): never {
  throw new SatiError("USAGE", "A handoff needs a task.", {
    hint: `Run \`${CLI_NAME} handoff <task> --next "where to continue"\`.`,
  });
}
