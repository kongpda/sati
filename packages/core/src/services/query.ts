import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { ID_PREFIXES, parseHandle, parseId, shortHandle } from "../domain/ids.js";
import type { EntityMap, StoredEntity } from "../domain/schemas.js";
import { FEATURE_STATUSES, MILESTONE_STATUSES, TASK_STATUSES } from "../domain/status.js";
import { CLI_NAME } from "../name.js";
import { type ListQuery, SEARCHABLE, type SearchHit } from "../ports/storage.js";
import { mustGet, parseInput, type ServiceContext } from "./context.js";

const STATUSES: Partial<Record<StoredEntity, readonly [string, ...string[]]>> = {
  task: TASK_STATUSES,
  feature: FEATURE_STATUSES,
  milestone: MILESTONE_STATUSES,
};

const id = z.string().max(60);

export function listInput(entity: StoredEntity) {
  const statuses = STATUSES[entity];
  return z.strictObject({
    status: z
      .array(statuses ? z.enum(statuses) : z.never())
      .max(10)
      .optional(),
    featureId: id.optional(),
    milestoneId: id.optional(),
    parentId: id.optional(),
    label: z.string().max(100).optional(),
    includeDeleted: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  });
}

export async function getRecord<E extends StoredEntity>(
  ctx: ServiceContext,
  entity: E,
  recordId: string,
): Promise<EntityMap[E]> {
  return ctx.store.read((r) => mustGet(r, ctx, entity, recordId));
}

export async function listRecords<E extends StoredEntity>(
  ctx: ServiceContext,
  entity: E,
  input: unknown = {},
): Promise<EntityMap[E][]> {
  const query: ListQuery = parseInput(listInput(entity), input);
  return ctx.store.read((r) => r.list(entity, ctx.projectId, query));
}

/**
 * Turns a full ID or a short handle (`tsk_8f3k2a`) into a full ID of this project.
 * A handle matching several records fails with AMBIGUOUS and lists them.
 */
export async function resolveId(
  ctx: ServiceContext,
  entity: StoredEntity,
  ref: string,
  /** Match only deleted records, for restore. */
  opts: { deleted?: boolean } = {},
): Promise<string> {
  const input = ref.trim();
  const prefix = ID_PREFIXES[entity];
  const wrongKind = () =>
    new SatiError(
      "VALIDATION",
      `"${input}" is not ${/^[aeiou]/u.test(entity) ? "an" : "a"} ${entity} id.`,
      {
        hint: `${entity} ids look like ${prefix}_8f3k2a.`,
      },
    );
  const full = parseId(input);
  if (full) {
    if (full.prefix !== prefix) throw wrongKind();
    return input;
  }
  const handle = parseHandle(input);
  if (!handle || handle.prefix !== prefix) throw wrongKind();
  const matches = await ctx.store.read(async (r) =>
    (await r.findBySuffix(entity, handle.suffix)).filter(
      (rec) =>
        (opts.deleted ? rec.deletedAt !== null : rec.deletedAt === null) &&
        ("projectId" in rec ? rec.projectId : rec.id) === ctx.projectId,
    ),
  );
  const [only, ...rest] = matches;
  if (!only) {
    throw new SatiError(
      "NOT_FOUND",
      `No ${opts.deleted ? "deleted " : ""}${entity} matches ${input}.`,
      {
        hint: opts.deleted
          ? `Find its id in \`${CLI_NAME} activity\`.`
          : `List them with \`${CLI_NAME} ${entity} list\`.`,
      },
    );
  }
  if (rest.length > 0) {
    throw new SatiError("AMBIGUOUS", `${input} matches ${matches.length} ${entity} records.`, {
      hint: "Use more characters of the id, or the full id.",
      details: { candidates: matches.map((m) => ({ id: m.id, handle: shortHandle(m.id) })) },
    });
  }
  return only.id;
}

export const SearchInput = z.strictObject({
  query: z.string().trim().min(1).max(500),
  entities: z.array(z.enum(SEARCHABLE)).max(SEARCHABLE.length).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  match: z.enum(["all", "any"]).optional(),
});
export type SearchInput = z.input<typeof SearchInput>;

/** Full-text search across tasks, features, notes and decisions of this project. */
export async function search(ctx: ServiceContext, input: unknown): Promise<SearchHit[]> {
  const { query, ...opts } = parseInput(SearchInput, input);
  return ctx.store.read((r) => r.search(ctx.projectId, query, opts));
}

/** Record prefixes a note link may name by short handle. */
const LINKABLE: Record<string, StoredEntity> = {
  tsk: "task",
  note: "note",
  dec: "decision",
  feat: "feature",
  mil: "milestone",
};

/**
 * Note links are URLs, paths or ids. A short handle of a record becomes its full id, so a comment
 * linked by handle still shows in that record's thread; anything else is kept as written.
 */
export async function resolveLinks(ctx: ServiceContext, links: string[]): Promise<string[]> {
  return Promise.all(
    links.map(async (link) => {
      const handle = parseHandle(link);
      const entity = handle && !parseId(link) ? LINKABLE[handle.prefix] : undefined;
      return entity ? resolveId(ctx, entity, link) : link;
    }),
  );
}
