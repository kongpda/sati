import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { Note } from "../domain/schemas.js";
import { COMMENT_TAG } from "./comment.js";
import {
  baseFields,
  ExpectedVersion,
  insertWithLog,
  mustGet,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";

const fields = Note.pick({ title: true, body: true, tags: true, links: true, pinned: true });
export const CreateNoteInput = fields.partial({
  body: true,
  tags: true,
  links: true,
  pinned: true,
});
export const UpdateNoteInput = fields
  .partial()
  .extend(ExpectedVersion)
  .extend({ reviewed: z.literal(true).optional() });
export type CreateNoteInput = z.input<typeof CreateNoteInput>;

/**
 * Comments are made only by `addComment`, which checks what they are on. A plain note cannot
 * gain or lose the tag, and a comment keeps its record, tags and title; only its author edits
 * its text, so a thread never shows words under someone else's name.
 */
function guardComment(
  ctx: ServiceContext,
  before: Note | undefined,
  patch: Partial<Record<"title" | "body", string | undefined>> & {
    tags?: string[] | undefined;
    links?: string[] | undefined;
    pinned?: boolean | undefined;
  },
): void {
  const was = before?.tags.includes(COMMENT_TAG) ?? false;
  if (!was) {
    if (patch.tags?.includes(COMMENT_TAG)) {
      throw new SatiError("VALIDATION", "Comments are added to a task, note or decision.", {
        hint: "Use `comment add <id> <text>`, or note_upsert with only body, tags [comment] and one link.",
      });
    }
    return;
  }
  const same = (a: string[] | undefined, b: string[]) =>
    a === undefined || a.join("\n") === b.join("\n");
  const fixed =
    same(patch.tags, before?.tags ?? []) &&
    same(patch.links, before?.links ?? []) &&
    (patch.title === undefined || patch.title === before?.title) &&
    (patch.pinned === undefined || patch.pinned === before?.pinned);
  if (!fixed) {
    throw new SatiError("VALIDATION", "A comment's record, tags and title cannot change.", {
      hint: "Delete it and add a new comment instead.",
    });
  }
  if (patch.body !== undefined && before?.createdBy !== ctx.actorId) {
    throw new SatiError("CONFLICT", "Only the author can edit a comment.");
  }
}

export async function createNote(ctx: ServiceContext, input: unknown): Promise<Note> {
  const data = parseInput(CreateNoteInput, input);
  guardComment(ctx, undefined, data);
  return ctx.store.write((w) =>
    insertWithLog(w, ctx, "note", {
      ...baseFields(ctx, "note"),
      body: "",
      tags: [],
      links: [],
      pinned: false,
      ...data,
    }),
  );
}

export async function updateNote(ctx: ServiceContext, id: string, input: unknown): Promise<Note> {
  const { expectedVersion, reviewed, ...patch } = parseInput(UpdateNoteInput, input);
  return ctx.store.write(async (w) => {
    const before = await mustGet(w, ctx, "note", id);
    guardComment(ctx, before, patch);
    return updateWithLog(w, ctx, "note", before, patch, {
      expectedVersion,
      clear: reviewed ? ["needsReview"] : [],
    });
  });
}
