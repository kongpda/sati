import { createHash } from "node:crypto";
import micromatch from "micromatch";
import { z } from "zod";
import { normalizeLockPath, pathsOverlap } from "../domain/locks.js";
import { ContextEntry, LIMITS } from "../domain/schemas.js";
import type { RepoFile } from "../ports/repo.js";
import {
  baseFields,
  insertWithLog,
  listAll,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";

const ModulePath = z
  .string()
  .min(1)
  .max(LIMITS.path)
  .transform((raw, c) => {
    const p = normalizeLockPath(raw);
    if (p === undefined) {
      c.addIssue({ code: "custom", message: `"${raw}" is not a repo-relative path or glob` });
      return z.NEVER;
    }
    return p;
  });

export const PutContextInput = z.strictObject({
  path: ModulePath,
  summary: ContextEntry.shape.summary.min(1),
  keyFiles: z.array(ModulePath).max(LIMITS.array).optional(),
});
export type PutContextInput = z.input<typeof PutContextInput>;

export const GetContextInput = z.strictObject({
  /** Only entries whose path overlaps this one. All entries when absent. */
  path: ModulePath.optional(),
});
export type GetContextInput = z.input<typeof GetContextInput>;

export interface ContextView extends ContextEntry {
  /** The files under `path` changed since the summary was written. null: no git repo to check. */
  stale: boolean | null;
}

/**
 * Hash of the tracked files a module path covers: the path as a glob, or a directory and
 * everything beneath it. It uses the blob ids from `git ls-files -s`, so no file is read.
 */
export function moduleHash(path: string, files: readonly RepoFile[]): string {
  const exact = micromatch.matcher(path, { dot: true });
  const beneath = micromatch.matcher(`${path}/**`, { dot: true });
  const lines = files
    .filter((f) => exact(f.path) || beneath(f.path))
    .map((f) => `${f.blob} ${f.path}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * Stores what an agent learned about a module, one entry per path. Only the summary and a hash
 * of the module's files are kept, never file contents. Writing the same path again replaces
 * the entry and refreshes the hash.
 */
export async function putContext(ctx: ServiceContext, input: unknown): Promise<ContextEntry> {
  const data = parseInput(PutContextInput, input);
  // git runs before the transaction, so the write lock is held only for the DB work.
  const files = ctx.repo ? await ctx.repo.files() : undefined;
  const gitCommit = ctx.repo ? await ctx.repo.head() : null;
  const fields = {
    path: data.path,
    summary: data.summary,
    keyFiles: data.keyFiles ?? [],
    contentHash: files ? moduleHash(data.path, files) : "",
    gitCommit,
  };
  return ctx.store.write(async (w) => {
    const existing = (await listAll(w, ctx, "context")).find((e) => e.path === data.path);
    if (existing) return updateWithLog(w, ctx, "context", existing, fields);
    return insertWithLog(w, ctx, "context", { ...baseFields(ctx, "context"), ...fields });
  });
}

/** Context entries with a `stale` flag, recomputed from the git index on every call. */
export async function getContext(ctx: ServiceContext, input: unknown = {}): Promise<ContextView[]> {
  const { path } = parseInput(GetContextInput, input);
  const all = await ctx.store.read((r) => listAll(r, ctx, "context"));
  const entries = path === undefined ? all : all.filter((e) => pathsOverlap(path, e.path));
  if (entries.length === 0) return [];
  const files = ctx.repo ? await ctx.repo.files() : undefined;
  return entries
    .map((e) => ({ ...e, stale: files ? moduleHash(e.path, files) !== e.contentHash : null }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
