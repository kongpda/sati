import { z } from "zod";
import { type Note } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
/**
 * A comment is a note tagged `comment` and linked to the task, note or decision it is on, the way
 * a handoff is. So it needs no table, migration, snapshot folder or MCP tool of its own: notes are
 * already exported, merged, searchable and restorable.
 */
export declare const COMMENT_TAG = "comment";
/** A comment is a short reply, not a document: notes are for long text. */
export declare const COMMENT_MAX = 10000;
export declare const AddCommentInput: z.ZodObject<{
    on: z.ZodString;
    body: z.ZodString;
}, z.core.$strict>;
export type AddCommentInput = z.input<typeof AddCommentInput>;
/** A full id or short handle of a task, note or decision, as a full id. The prefix says which. */
export declare function commentTarget(ctx: ServiceContext, ref: string): Promise<string>;
/** Adds a comment by the caller to a task, note or decision. */
export declare function addComment(ctx: ServiceContext, input: unknown): Promise<Note>;
/** True for the notes shown in a record's thread: comments and handoffs linked to it. */
export declare function isThreadNote(note: Note, on?: string): boolean;
/** The comments and handoffs on a record, oldest first. */
export declare function listComments(ctx: ServiceContext, on: string): Promise<Note[]>;
