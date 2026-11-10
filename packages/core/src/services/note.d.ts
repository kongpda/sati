import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { Note } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
export declare const CreateNoteInput: z.ZodObject<{
    title: z.ZodString;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    links: z.ZodOptional<z.ZodArray<z.ZodString>>;
    pinned: z.ZodOptional<z.ZodBoolean>;
    body: z.ZodOptional<z.ZodString>;
    private: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export declare const UpdateNoteInput: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    links: z.ZodOptional<z.ZodArray<z.ZodString>>;
    pinned: z.ZodOptional<z.ZodBoolean>;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
    body: z.ZodOptional<z.ZodString>;
    private: z.ZodOptional<z.ZodBoolean>;
    reviewed: z.ZodOptional<z.ZodLiteral<true>>;
    acknowledge: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strict>;
export type CreateNoteInput = z.input<typeof CreateNoteInput>;
/** A shared record is in `.sati/` and git history already; marking it private would hide nothing. */
export declare function alreadyShared(what: string): SatiError;
export declare function createNote(ctx: ServiceContext, input: unknown): Promise<Note>;
export declare function updateNote(ctx: ServiceContext, id: string, input: unknown): Promise<Note>;
