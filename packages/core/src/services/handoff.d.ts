import { z } from "zod";
import { type Note } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
export declare const HANDOFF_TAG = "handoff";
export declare const HandoffInput: z.ZodObject<{
    taskId: z.ZodString;
    done: z.ZodDefault<z.ZodString>;
    next: z.ZodDefault<z.ZodString>;
    questions: z.ZodDefault<z.ZodString>;
    files: z.ZodDefault<z.ZodArray<z.ZodString>>;
    to: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type HandoffInput = z.input<typeof HandoffInput>;
export declare function handoffBody(input: {
    done: string;
    next: string;
    questions: string;
    files: readonly string[];
}): string;
/** The next-step section, for the brief. Empty when the note is not a handoff. */
export declare function handoffNext(body: string): string;
/** Writes or replaces the handoff note linked to a task. One note per task. */
export declare function writeHandoff(ctx: ServiceContext, input: unknown): Promise<{
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: string | null;
    needsReview?: true | undefined;
    stamps?: Record<string, string> | undefined;
    id: string;
    title: string;
    body: string;
    tags: string[];
    links: string[];
    pinned: boolean;
    private?: true | undefined;
    handoffTo?: string | undefined;
    handoffToName?: string | undefined;
    handoffFromName?: string | undefined;
    acknowledged?: {
        by: string;
        at: string;
    } | undefined;
}>;
/**
 * True when a handoff is addressed to this actor: by id in the clone it was written in, by name in
 * a teammate's clone, where the id is unknown. A handoff for no one is for whoever claims next.
 */
export declare function handoffFor(n: Note, actor: {
    id: string;
    name?: string;
} | undefined): boolean;
/** True for a handoff that is still unread by the actor it is for. */
export declare const unreadHandoff: (n: Note) => boolean;
/**
 * Marks a handoff read. A handoff for one actor is acknowledged by that actor or a person; one
 * for whoever comes next, by anyone but its author.
 */
export declare function acknowledgeHandoff(ctx: ServiceContext, noteId: string): Promise<Note>;
