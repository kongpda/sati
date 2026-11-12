import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { BodyText, Note } from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
import { COMMENT_TAG } from "./comment.js";
import {
  baseFields,
  ExpectedVersion,
  insertWithLog,
  mustGet,
  parseInput,
  type ServiceContext,
  updateWithLog,
  writeTx,
} from "./context.js";
import { acknowledgeHandoff, HANDOFF_TAG } from "./handoff.js";

const fields = Note.pick({ title: true, tags: true, links: true, pinned: true }).extend({
  body: BodyText,
});
/**
 * `private: true` keeps a note on this machine. Set when it is created; a private note can be
 * shared later (`false`), but a shared one is already in `.sati/` and git history, so it cannot
 * be made private again.
 */
const Private = { private: z.boolean().optional() };
export const CreateNoteInput = fields
  .partial({
    body: true,
    tags: true,
    links: true,
    pinned: true,
  })
  .extend(Private);
export const UpdateNoteInput = fields
  .partial()
  .extend(ExpectedVersion)
  .extend(Private)
  .extend({
    reviewed: z.literal(true).optional(),
    /** Mark a handoff note read; see `acknowledgeHandoff` for who may. */
    acknowledge: z.literal(true).optional(),
  });
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
        hint: "Use `comment add <id> <text>`, or the MCP note_upsert with only body, tags [comment] and one link.",
      });
    }
    // The same for a handoff: the next agent to claim the task is shown it as one.
    if (patch.tags?.includes(HANDOFF_TAG) && !before?.tags.includes(HANDOFF_TAG)) {
      throw new SatiError("VALIDATION", "A handoff is written on a task.", {
        hint: "Use `handoff <task-id>`, or handoff_write.",
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
    throw new SatiError("INVALID_TRANSITION", "Only the author can edit a comment.");
  }
}

/** A shared record is in `.sati/` and git history already; marking it private would hide nothing. */
export function alreadyShared(what: string): SatiError {
  return new SatiError(
    "VALIDATION",
    `This ${what} is already shared, so it cannot become private.`,
    {
      hint: "It is in .sati/ and git history. Delete it and save a new private one; rotate anything sensitive in it.",
    },
  );
}

export async function createNote(ctx: ServiceContext, input: unknown): Promise<Note> {
  const { private: hidden, ...data } = parseInput(CreateNoteInput, input);
  guardComment(ctx, undefined, data);
  refuseSecrets("note", data);
  return writeTx(ctx, (w) =>
    insertWithLog(w, ctx, "note", {
      ...baseFields(ctx, "note"),
      body: "",
      tags: [],
      links: [],
      pinned: false,
      ...data,
      ...(hidden ? { private: true } : {}),
    }),
  );
}

export async function updateNote(ctx: ServiceContext, id: string, input: unknown): Promise<Note> {
  const {
    expectedVersion,
    reviewed,
    acknowledge,
    private: hidden,
    ...patch
  } = parseInput(UpdateNoteInput, input);
  if (acknowledge) {
    if (Object.keys(patch).length > 0 || reviewed || hidden !== undefined) {
      throw new SatiError("VALIDATION", "Acknowledge a handoff on its own, without other changes.");
    }
    return acknowledgeHandoff(ctx, id);
  }
  refuseSecrets("note", patch);
  return writeTx(ctx, async (w) => {
    const before = await mustGet(w, ctx, "note", id);
    guardComment(ctx, before, patch);
    const clear = [
      ...(reviewed ? ["needsReview"] : []),
      ...(hidden === false && before.private ? ["private"] : []),
    ];
    if (hidden === true && !before.private) throw alreadyShared("note");
    return updateWithLog(w, ctx, "note", before, patch, { expectedVersion, clear });
  });
}
