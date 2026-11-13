import { createHash } from "node:crypto";
import micromatch from "micromatch";
import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { pathsOverlap } from "../domain/locks.js";
import {
  CardPath,
  ContextEntry,
  isExternalKey,
  LIMITS,
  RepoPath,
  Sha256,
} from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
import { CLI_NAME } from "../name.js";
import type { RepoFile } from "../ports/repo.js";
import {
  baseFields,
  ExpectedVersion,
  insertWithLog,
  listAll,
  nowIso,
  parseInput,
  type ServiceContext,
  updateWithLog,
  writeTx,
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
  /** The card's version when it was read; a save of a newer card is then refused. */
  ...ExpectedVersion,
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
  const { private: hidden, expectedVersion, ...data } = parseInput(PutContextInput, input);
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
  return writeTx(ctx, async (w) => {
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
        {
          expectedVersion,
          clear: [...clear, ...(existing.private && !keepPrivate ? ["private"] : [])],
        },
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
  return contextViews(ctx, all, path, seen);
}

/** `getContext` on cards already read: the brief reads the card table once (review 11.1). */
export async function contextViews(
  ctx: ServiceContext,
  all: readonly ContextEntry[],
  path?: string,
  seen?: string,
): Promise<ContextView[]> {
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

export const ApproveCardInput = z.strictObject({
  path: RepoPath,
  /** SHA-256 of the file's bytes as it is now. `null` takes the approval away. */
  hash: Sha256.nullable(),
});
export type ApproveCardInput = z.input<typeof ApproveCardInput>;

/**
 * Marks the file at `path` as approved in the version with this hash, or takes the approval away.
 * The caller hashes the file: core does no I/O. A file with no card yet gets one, so approving
 * needs no agent to have read it first. The guard then blocks a change to the file.
 */
export async function approveCard(ctx: ServiceContext, input: unknown): Promise<ContextEntry> {
  const { path, hash } = parseInput(ApproveCardInput, input);
  if (/[*?[\]{}]/u.test(path) || cardFile(path) !== path) {
    throw new SatiError("VALIDATION", `Approve one whole file, not "${path}".`, {
      hint: "Give the path of the file, without a wildcard or a `#part`.",
    });
  }
  const files = ctx.repo && hash !== null ? await ctx.repo.files() : undefined;
  const gitCommit = ctx.repo && hash !== null ? await ctx.repo.head() : null;
  return writeTx(ctx, async (w) => {
    // The sign-off is a person's word that the file is right. An agent that could give or take
    // it away could unlock any file it wants to change.
    if ((await w.get("actor", ctx.actorId))?.kind !== "human") {
      throw new SatiError(
        "INVALID_TRANSITION",
        "Only a person can approve a file or take its approval away.",
        {
          hint: `Ask a person to run \`${CLI_NAME} card approve ${path}\`, or to use Approve on the board.`,
        },
      );
    }
    const existing = (await listAll(w, ctx, "context", { path })).find((e) => e.path === path);
    if (hash === null) {
      if (!existing?.approved) throw new SatiError("NOT_FOUND", `${path} is not approved.`);
      return updateWithLog(w, ctx, "context", existing, {}, { clear: ["approved"] });
    }
    const approved = { hash, by: ctx.actorId, at: nowIso(ctx) };
    if (existing) return updateWithLog(w, ctx, "context", existing, { approved });
    return insertWithLog(w, ctx, "context", {
      ...baseFields(ctx, "context"),
      path,
      summary: "Approved file.",
      keyFiles: [],
      contentHash: files ? moduleHash(path, files) : "",
      gitCommit,
      approved,
    });
  });
}

/** How an approved file compares with the version a person approved. */
export type ApprovalState = "kept" | "changed" | "missing" | "unchecked";

/**
 * Each approved card with the state of its file now. `unchecked` when files cannot be read here
 * (no `sha256` port) or the file is too large to hash each time; the guard still checks those.
 */
export async function approvalStates(
  ctx: ServiceContext,
  cards?: readonly ContextEntry[],
): Promise<{ card: ContextEntry; state: ApprovalState }[]> {
  const approved = (cards ?? (await approvedCards(ctx))).filter((c) => c.approved !== undefined);
  const out: { card: ContextEntry; state: ApprovalState }[] = [];
  for (const card of approved) {
    const hash = ctx.repo?.sha256 ? await ctx.repo.sha256(card.path) : undefined;
    const state =
      hash === undefined
        ? "unchecked"
        : hash === null
          ? "missing"
          : hash === card.approved?.hash
            ? "kept"
            : "changed";
    out.push({ card, state });
  }
  return out;
}

/** The approved cards, read without the file list: the guard asks on every commit. */
export async function approvedCards(ctx: ServiceContext): Promise<ContextEntry[]> {
  const all = await ctx.store.read((r) => listAll(r, ctx, "context", { approved: true }));
  // An older `sati serve` ignores the filter; the check keeps the answer right with it.
  return all.filter((c) => c.approved !== undefined);
}
