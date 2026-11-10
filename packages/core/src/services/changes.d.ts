import { z } from "zod";
import type { FeatureStatus } from "../domain/status.js";
import type { StorageReader } from "../ports/storage.js";
import { type ServiceContext } from "./context.js";
/** Tasks with this label never reach a changelog or digest. */
export declare const INTERNAL_LABEL = "internal";
export declare const CHANGE_FORMATS: readonly ["plain", "changelog", "digest"];
export type ChangeFormat = (typeof CHANGE_FORMATS)[number];
export declare const ChangesInput: z.ZodObject<{
    since: z.ZodOptional<z.ZodString>;
    milestoneId: z.ZodOptional<z.ZodString>;
    actorId: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type ChangesInput = z.input<typeof ChangesInput>;
interface ItemBase {
    id: string;
    title: string;
    /** When it happened (UTC). */
    at: string;
    /** Who did it, when the record says; `null` for records written before stamps. */
    by: string | null;
    milestoneId: string | null;
    featureId: string | null;
}
export type ChangeItem = (ItemBase & {
    kind: "done";
    labels: string[];
    summary: string;
    releaseNote: string | null;
    filesTouched: string[];
}) | (ItemBase & {
    kind: "feature";
    status: FeatureStatus;
}) | (ItemBase & {
    kind: "decision";
}) | (ItemBase & {
    kind: "note";
    edited: boolean;
});
export interface Changes {
    project: string;
    /** Start of the window (UTC, inclusive). */
    since: string;
    /** How `since` was chosen, in words: "the last 7 days", "your last session". */
    basis: string;
    /** The milestone filter, if any. */
    milestone: {
        id: string;
        title: string;
    } | null;
    /** Newest first. */
    items: ChangeItem[];
    /** Open tasks that are blocked now. */
    blocked: {
        id: string;
        title: string;
    }[];
    /** Open tasks past their due day. */
    overdue: {
        id: string;
        title: string;
        dueDate: string;
    }[];
    /** Every milestone, in roadmap order, to group items by. */
    milestones: {
        id: string;
        title: string;
    }[];
}
/**
 * The end of your last session: your last write, not counting what sati does on its own
 * (imports, released claims). A session-scoped agent skips its own current session.
 */
export declare function lastSession(r: StorageReader, ctx: ServiceContext): Promise<{
    at: string | null;
    selves: Set<string>;
}>;
/** Everything that changed at or after `since`, read inside one snapshot. */
export declare function readChanges(r: StorageReader, ctx: ServiceContext, opts: {
    since: string;
    milestoneId?: string | undefined;
    actorId?: string | undefined;
}): Promise<Omit<Changes, "basis" | "project">>;
/**
 * What changed: done tasks with their summary, release note and files, features that moved
 * status, decisions, new and edited notes (not comments), and what is blocked or overdue now.
 * Built from the records, so changes pulled in from teammates through git count too.
 */
export declare function listChanges(ctx: ServiceContext, input?: unknown): Promise<Changes>;
/** Renders changes as text. Every format prints to stdout; sati writes no user files. */
export declare function formatChanges(c: Changes, format?: ChangeFormat): string;
/**
 * What the product does today, for READMEs, sales sheets or release pages: shipped features
 * (and deprecated ones, marked) with their acceptance criteria, grouped by milestone.
 */
export declare function featureList(ctx: ServiceContext): Promise<string>;
export {};
