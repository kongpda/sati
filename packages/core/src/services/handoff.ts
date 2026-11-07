import { z } from "zod";
import { BodyText, LIMITS } from "../domain/schemas.js";
import {
  baseFields,
  insertWithLog,
  listAll,
  mustGet,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";

export const HANDOFF_TAG = "handoff";

export const HandoffInput = z.strictObject({
  taskId: z.string().trim().min(1),
  done: BodyText.default(""),
  next: z.string().max(LIMITS.shortText).default(""),
  questions: BodyText.default(""),
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
  const body = handoffBody(data);
  // One transaction: two concurrent handoffs must not both see "no note" and each create one.
  return ctx.store.write(async (w) => {
    const task = await mustGet(w, ctx, "task", data.taskId);
    const existing = (await listAll(w, ctx, "note")).find(
      (n) => n.tags.includes(HANDOFF_TAG) && n.links.includes(task.id),
    );
    if (existing) return updateWithLog(w, ctx, "note", existing, { body });
    return insertWithLog(w, ctx, "note", {
      ...baseFields(ctx, "note"),
      title: `Handoff ${task.title}`.slice(0, LIMITS.title),
      body,
      tags: [HANDOFF_TAG],
      links: [task.id],
      pinned: false,
    });
  });
}
