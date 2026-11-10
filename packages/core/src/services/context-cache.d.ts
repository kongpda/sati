import { z } from "zod";
import { ContextEntry } from "../domain/schemas.js";
import type { RepoFile } from "../ports/repo.js";
import { type ServiceContext } from "./context.js";
export declare const PutContextInput: z.ZodObject<{
    path: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
    summary: z.ZodString;
    keyFiles: z.ZodOptional<z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>>;
    facts: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sourceSeen: z.ZodOptional<z.ZodString>;
    sourceTokens: z.ZodOptional<z.ZodNumber>;
    private: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type PutContextInput = z.input<typeof PutContextInput>;
export declare const GetContextInput: z.ZodObject<{
    path: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
}, z.core.$strict>;
export type GetContextInput = z.input<typeof GetContextInput>;
export interface ContextView extends ContextEntry {
    /** The files under `path` changed since the summary was written. null: no git repo to check. */
    stale: boolean | null;
}
/**
 * Hash of the tracked files a module path covers: the path as a glob, or a directory and
 * everything beneath it. It uses the blob ids from `git ls-files -s`, so no file is read.
 */
export declare function moduleHash(path: string, files: readonly RepoFile[]): string;
/**
 * Stores what an agent learned about a module or file, one card per path: a summary, facts,
 * tags and the file version it read. sati keeps a hash of the module's tracked files, never their
 * contents, and never opens a file. Writing the same path again replaces the card (facts and tags
 * not given are cleared) and refreshes the hash; privacy is kept unless changed.
 */
export declare function putContext(ctx: ServiceContext, input: unknown): Promise<ContextEntry>;
/**
 * Whether a card's files changed since it was saved: null when it cannot be told (no file list,
 * or a card saved before its folder had one, which has no hash to compare).
 */
export declare function staleness(contentHash: string, path: string, files: readonly RepoFile[] | undefined): boolean | null;
/** Context entries with a `stale` flag, recomputed from the file list on every call. */
export declare function getContext(ctx: ServiceContext, input?: unknown): Promise<ContextView[]>;
