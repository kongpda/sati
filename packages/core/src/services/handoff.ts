import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { BodyText, LIMITS, type Note } from "../domain/schemas.js";
import {
  baseFields,
  insertWithLog,
  listAll,
  mustGet,
  nowIso,
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
  /** The actor it is for (an id). Without it, it is for whoever claims the task next. */
  to: z.string().trim().min(1).max(60).optional(),
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
    if (data.to) await mustGet(w, ctx, "actor", data.to);
    const existing = (await listAll(w, ctx, "note")).find(
      (n) => n.tags.includes(HANDOFF_TAG) && n.links.includes(task.id),
    );
    const to = data.to ? { handoffTo: data.to } : {};
    if (existing) {
      // A rewritten handoff is new news: it is unread again, for the new addressee if any.
      return updateWithLog(
        w,
        ctx,
        "note",
        existing,
        { body, ...to },
        { clear: ["acknowledged", ...(data.to ? [] : ["handoffTo"])] },
      );
    }
    return insertWithLog(w, ctx, "note", {
      ...baseFields(ctx, "note"),
      title: `Handoff ${task.title}`.slice(0, LIMITS.title),
      body,
      tags: [HANDOFF_TAG],
      links: [task.id],
      pinned: false,
      ...to,
    });
  });
}

/** True for a handoff that is still unread by the actor it is for. */
export const unreadHandoff = (n: Note): boolean =>
  n.tags.includes(HANDOFF_TAG) && n.acknowledged === undefined;

/**
 * Marks a handoff read. A handoff for one actor is acknowledged by that actor or a person; one
 * for whoever comes next, by anyone but its author.
 */
export async function acknowledgeHandoff(ctx: ServiceContext, noteId: string): Promise<Note> {
  return ctx.store.write(async (w) => {
    const note = await mustGet(w, ctx, "note", noteId);
    if (!note.tags.includes(HANDOFF_TAG)) {
      throw new SatiError("VALIDATION", `Note ${noteId} is not a handoff.`);
    }
    if (note.acknowledged) return note;
    const caller = await w.get("actor", ctx.actorId);
    const person = caller?.kind === "human";
    const allowed = note.handoffTo
      ? note.handoffTo === ctx.actorId || person
      : note.createdBy !== ctx.actorId || person;
    if (!allowed) {
      throw new SatiError("CONFLICT", `Handoff ${noteId} is for someone else to acknowledge.`);
    }
    return updateWithLog(w, ctx, "note", note, {
      acknowledged: { by: ctx.actorId, at: nowIso(ctx) },
    });
  });
}
