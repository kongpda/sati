import { createHash } from "node:crypto";
import micromatch from "micromatch";
import { z } from "zod";
import { pathsOverlap } from "../domain/locks.js";
import { CardPath, ContextEntry, isExternalKey, LIMITS, RepoPath } from "../domain/schemas.js";
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

const card = ContextEntry.shape;
export const PutContextInput = z.strictObject({
  path: CardPath,
  summary: card.summary.min(1),
  keyFiles: z.array(RepoPath).max(LIMITS.array).optional(),
  facts: card.facts,
  tags: card.tags,
  sourceSeen: card.sourceSeen,
  sourceTokens: card.sourceTokens,
  /** Keep this card on this machine; see `private` on notes. Left out: unchanged. */
  private: z.boolean().optional(),
});
export type PutContextInput = z.input<typeof PutContextInput>;

export const GetContextInput = z
  .strictObject({
    /** Only entries whose path overlaps this one. All entries when absent. */
    path: CardPath.optional(),
    /**
     * The version of the file at `path` the caller sees now (modified time or hash, in the form
     * it gave as `sourceSeen`). The card for `path` is stale when the two differ.
     */
    seen: card.sourceSeen,
  })
  .refine((v) => v.seen === undefined || v.path !== undefined, {
    message: "`seen` needs the `path` of the file it describes",
    path: ["seen"],
  });
export type GetContextInput = z.input<typeof GetContextInput>;

export interface ContextView extends ContextEntry {
  /** The files under `path` changed since the summary was written. null: no git repo to check. */
  stale: boolean | null;
}

/** `budget.xlsx#Sheet2`: a file with an extension, then the part of it the card is about. */
const ANCHORED = /^(.+\.[A-Za-z0-9]+)#[^/#]+$/u;

/**
 * The file a card path names: the path without its anchor (`budget.xlsx#Sheet2`,
 * `deck.pptx#slide-12`, `contract.pdf#p4`). A file really named with a `#` is known from the
 * file list and kept whole.
 */
export function cardFile(path: string, files?: readonly RepoFile[]): string {
  // In a link the part is the fragment, wherever the query puts the file name.
  if (/^https?:/iu.test(path)) return path.replace(/#[^#]*$/u, "");
  const file = ANCHORED.exec(path)?.[1];
  if (file === undefined || files?.some((f) => f.path === path)) return path;
  return file;
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
 *
 * A card for a web link or a file outside the project has no hash: sati cannot see it change, so
 * only the caller's `seen` tells. A new card for an outside file is private unless the caller
 * says otherwise, because its path names a folder on this machine.
 */
export async function putContext(ctx: ServiceContext, input: unknown): Promise<ContextEntry> {
  const { private: hidden, ...data } = parseInput(PutContextInput, input);
  refuseSecrets("context", data);
  // git runs before the transaction, so the write lock is held only for the DB work.
  const outside = isExternalKey(data.path);
  const files = ctx.repo && !outside ? await ctx.repo.files() : undefined;
  const gitCommit = ctx.repo ? await ctx.repo.head() : null;
  const local = outside && !/^https?:/iu.test(data.path);
  const fields = {
    path: data.path,
    summary: data.summary,
    keyFiles: data.keyFiles ?? [],
    contentHash: files ? moduleHash(cardFile(data.path, files), files) : "",
    gitCommit,
    ...(data.facts?.length ? { facts: data.facts } : {}),
    ...(data.tags?.length ? { tags: data.tags } : {}),
    ...(data.sourceSeen ? { sourceSeen: data.sourceSeen } : {}),
    ...(data.sourceTokens !== undefined ? { sourceTokens: data.sourceTokens } : {}),
  };
  return ctx.store.write(async (w) => {
    // Looked up by path in SQL, not by reading every card.
    // The path check also guards against a store that ignores the filter (an old daemon).
    const existing = (await listAll(w, ctx, "context", { path: data.path })).find(
      (e) => e.path === data.path,
    );
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
      ...((hidden ?? local) ? { private: true } : {}),
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
  // A card about one sheet or page goes stale with its file: sati cannot see inside it.
  return files && contentHash !== "" && !isExternalKey(path)
    ? moduleHash(cardFile(path, files), files) !== contentHash
    : null;
}

/** Two card paths meet when their files overlap, unless they name different parts of one file. */
function cardsOverlap(a: string, b: string): boolean {
  const fa = cardFile(a);
  const fb = cardFile(b);
  // A link or an outside file is one thing, matched whole: `?` in a link is not a wildcard.
  const meet = isExternalKey(a) || isExternalKey(b) ? fa === fb : pathsOverlap(fa, fb);
  return meet && (fa === a || fb === b || a === b);
}

/** Context entries with a `stale` flag, recomputed from the file list on every call. */
export async function getContext(ctx: ServiceContext, input: unknown = {}): Promise<ContextView[]> {
  const { path, seen } = parseInput(GetContextInput, input);
  const all = await ctx.store.read((r) => listAll(r, ctx, "context"));
  const entries = path === undefined ? all : all.filter((e) => cardsOverlap(path, e.path));
  if (entries.length === 0) return [];
  const files = ctx.repo ? await ctx.repo.files() : undefined;
  return entries
    .map((e) => {
      const stale = staleness(e.contentHash, e.path, files);
      // The caller's own look at the file is the only evidence where sati has no file list (a
      // file outside the project, a folder too large to walk). It can add staleness, and it can
      // answer "unknown"; it never overrules a file list that says the file changed.
      const told =
        seen !== undefined &&
        e.sourceSeen !== undefined &&
        cardFile(e.path) === cardFile(path ?? "");
      return { ...e, stale: told ? stale === true || seen !== e.sourceSeen : stale };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
