import { z } from "zod";
import { Note } from "../domain/schemas.js";
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

export async function createNote(ctx: ServiceContext, input: unknown): Promise<Note> {
  const data = parseInput(CreateNoteInput, input);
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
    return updateWithLog(w, ctx, "note", before, patch, {
      expectedVersion,
      clear: reviewed ? ["needsReview"] : [],
    });
  });
}
