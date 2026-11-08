import { createHash } from "node:crypto";
import micromatch from "micromatch";
import { z } from "zod";
import { normalizeLockPath, pathsOverlap } from "../domain/locks.js";
import { ContextEntry, LIMITS } from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
import type { RepoFile } from "../ports/repo.js";
import {
  baseFields,
  insertWithLog,
  listAll,
  parseInput,
  type ServiceContext,
  updateWithLog,
} from "./context.js";
import { alreadyShared } from "./note.js";

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

const card = ContextEntry.shape;
export const PutContextInput = z.strictObject({
  path: ModulePath,
  summary: card.summary.min(1),
  keyFiles: z.array(ModulePath).max(LIMITS.array).optional(),
  facts: card.facts,
  tags: card.tags,
  sourceSeen: card.sourceSeen,
  sourceTokens: card.sourceTokens,
  /** Keep this card on this machine; see `private` on notes. Left out: unchanged. */
  private: z.boolean().optional(),
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
 * Stores what an agent learned about a module or file, one card per path: a summary, facts,
 * tags and the file version it read. sati keeps a hash of the module's tracked files, never their
 * contents, and never opens a file. Writing the same path again replaces the card (facts and tags
 * not given are cleared) and refreshes the hash; privacy is kept unless changed.
 */
export async function putContext(ctx: ServiceContext, input: unknown): Promise<ContextEntry> {
  const { private: hidden, ...data } = parseInput(PutContextInput, input);
  refuseSecrets("context", data);
  // git runs before the transaction, so the write lock is held only for the DB work.
  const files = ctx.repo ? await ctx.repo.files() : undefined;
  const gitCommit = ctx.repo ? await ctx.repo.head() : null;
  const fields = {
    path: data.path,
    summary: data.summary,
    keyFiles: data.keyFiles ?? [],
    contentHash: files ? moduleHash(data.path, files) : "",
    gitCommit,
    ...(data.facts?.length ? { facts: data.facts } : {}),
    ...(data.tags?.length ? { tags: data.tags } : {}),
    ...(data.sourceSeen ? { sourceSeen: data.sourceSeen } : {}),
    ...(data.sourceTokens !== undefined ? { sourceTokens: data.sourceTokens } : {}),
  };
  return ctx.store.write(async (w) => {
    // Looked up by path in SQL, not by reading every card.
    const [existing] = await listAll(w, ctx, "context", { path: data.path });
    if (existing) {
      if (hidden === true && !existing.private) throw alreadyShared("card");
      const keepPrivate = existing.private === true && hidden !== false;
      const clear = (["facts", "tags", "sourceSeen", "sourceTokens"] as const).filter(
        (k) => !(k in fields) && existing[k] !== undefined,
      );
      return updateWithLog(
        w,
        ctx,
        "context",
        existing,
        { ...fields, ...(keepPrivate ? { private: true } : {}) },
        { clear: [...clear, ...(existing.private && !keepPrivate ? ["private"] : [])] },
      );
    }
    return insertWithLog(w, ctx, "context", {
      ...baseFields(ctx, "context"),
      ...fields,
      ...(hidden ? { private: true } : {}),
    });
  });
}

/**
 * Whether a card's files changed since it was saved: null when it cannot be told (no file list,
 * or a card saved before its folder had one, which has no hash to compare).
 */
export function staleness(
  contentHash: string,
  path: string,
  files: readonly RepoFile[] | undefined,
) {
  return files && contentHash !== "" ? moduleHash(path, files) !== contentHash : null;
}

/** Context entries with a `stale` flag, recomputed from the file list on every call. */
export async function getContext(ctx: ServiceContext, input: unknown = {}): Promise<ContextView[]> {
  const { path } = parseInput(GetContextInput, input);
  const all = await ctx.store.read((r) => listAll(r, ctx, "context"));
  const entries = path === undefined ? all : all.filter((e) => pathsOverlap(path, e.path));
  if (entries.length === 0) return [];
  const files = ctx.repo ? await ctx.repo.files() : undefined;
  return entries
    .map((e) => ({ ...e, stale: staleness(e.contentHash, e.path, files) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
