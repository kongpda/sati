import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { parseHandle, parseId } from "../domain/ids.js";
import { COMMENT_TAG } from "../domain/inbox.js";
import { LIMITS, type Note } from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
import type { StorageReader } from "../ports/storage.js";
import {
  baseFields,
  insertWithLog,
  listAll,
  mustGet,
  parseInput,
  type ServiceContext,
} from "./context.js";
import { HANDOFF_TAG } from "./handoff.js";
import { resolveId } from "./query.js";

/**
 * A comment is a note tagged `comment` and linked to the task, note or decision it is on, the way
 * a handoff is. So it needs no table, migration, snapshot folder or MCP tool of its own: notes are
 * already exported, merged, searchable and restorable. The tag and the mention rule live in
 * `domain/inbox.ts`, which the board shares.
 */
export { COMMENT_TAG, mentionsOf } from "../domain/inbox.js";

/** The records a comment can be on, by id prefix. */
const TARGETS = { tsk: "task", note: "note", dec: "decision" } as const;
type Target = (typeof TARGETS)[keyof typeof TARGETS];

/** A comment is a short reply, not a document: notes are for long text. */
export const COMMENT_MAX = 10_000;

export const AddCommentInput = z.strictObject({
  /** Full id of the task, note or decision. */
  on: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1, "write something").max(COMMENT_MAX),
});
export type AddCommentInput = z.input<typeof AddCommentInput>;

function targetOf(id: string): Target {
  const prefix = parseId(id)?.prefix;
  const entity = prefix && prefix in TARGETS ? TARGETS[prefix as keyof typeof TARGETS] : undefined;
  if (!entity) {
    throw new SatiError("VALIDATION", `Comments go on a task, note or decision, not "${id}".`, {
      hint: "Pass the id of a task (tsk_), note (note_) or decision (dec_).",
    });
  }
  return entity;
}

/** A full id or short handle of a task, note or decision, as a full id. The prefix says which. */
export async function commentTarget(ctx: ServiceContext, ref: string): Promise<string> {
  const input = ref.trim();
  const prefix = parseId(input)?.prefix ?? parseHandle(input)?.prefix;
  const entity = prefix && prefix in TARGETS ? TARGETS[prefix as keyof typeof TARGETS] : undefined;
  if (!entity) targetOf(input);
  return resolveId(ctx, entity ?? "task", input);
}

/** The record's title, so the comment note says what it is about in lists and search. */
async function targetRecord(r: StorageReader, ctx: ServiceContext, id: string) {
  const record = await mustGet(r, ctx, targetOf(id), id);
  // Threads are one level deep: a reply goes on the record, not on another comment.
  if ("tags" in record && isThreadNote(record)) {
    throw new SatiError("VALIDATION", "Reply on the record the comment is on, not on the comment.");
  }
  return { title: record.title, private: "private" in record && record.private === true };
}

/** Adds a comment by the caller to a task, note or decision. */
export async function addComment(ctx: ServiceContext, input: unknown): Promise<Note> {
  const { on, body } = parseInput(AddCommentInput, input);
  refuseSecrets("note", { body });
  return ctx.store.write(async (w) => {
    const about = await targetRecord(w, ctx, on);
    return insertWithLog(w, ctx, "note", {
      ...baseFields(ctx, "note"),
      title: `Comment on ${about.title}`.slice(0, LIMITS.title),
      body,
      tags: [COMMENT_TAG],
      links: [on],
      pinned: false,
      // A comment on a private note stays on this machine with it.
      ...(about.private ? { private: true } : {}),
    });
  });
}

/** True for the notes shown in a record's thread: comments and handoffs linked to it. */
export function isThreadNote(note: Note, on?: string): boolean {
  const kind = note.tags.includes(COMMENT_TAG) || note.tags.includes(HANDOFF_TAG);
  return kind && (on === undefined || note.links.includes(on));
}

/** The comments and handoffs on a record, oldest first. */
export async function listComments(ctx: ServiceContext, on: string): Promise<Note[]> {
  return ctx.store.read(async (r) => {
    // A deleted record has no thread to show, whether it is named by handle or full id.
    await mustGet(r, ctx, targetOf(on), on);
    return (await listAll(r, ctx, "note", { linkTo: on }))
      .filter((n) => isThreadNote(n, on))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  });
}
