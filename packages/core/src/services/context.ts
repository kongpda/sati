import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { maxHlc, tickHlc } from "../domain/hlc.js";
import type { IdFactory } from "../domain/ids.js";
import {
  type Activity,
  ENTITY_SCHEMAS,
  type EntityMap,
  type StoredEntity,
  type VERBS,
} from "../domain/schemas.js";
import { CLI_NAME } from "../name.js";
import type { Clock } from "../ports/clock.js";
import type { ProcessProbe } from "../ports/process.js";
import type { RepoIndex } from "../ports/repo.js";
import type { ListQuery, StorageAdapter, StorageReader, StorageWriter } from "../ports/storage.js";

/** Everything a service call needs. One per command or MCP request. */
export interface ServiceContext {
  store: StorageAdapter;
  clock: Clock;
  ids: IdFactory;
  projectId: string;
  /** Who is acting; written to `createdBy` and to every activity row. */
  actorId: string;
  /** Current git branch, recorded on activity rows. */
  branch: string | null;
  /** The git index, for context-cache hashes. Absent outside a git repo. */
  repo?: RepoIndex;
  /** Whether claim holders still run, so claims of exited agents are released early. */
  processes?: ProcessProbe;
}

export type Verb = (typeof VERBS)[number];

/**
 * Validates untrusted input; failures become VALIDATION errors listing the first issues.
 * Top-level `undefined` values count as absent, so `{ body: undefined }` gets the default body
 * instead of overwriting it (Zod keeps explicit `undefined` keys in its output).
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const plain = input !== null && typeof input === "object" && !Array.isArray(input);
  const result = schema.safeParse(plain ? defined(input) : input);
  if (result.success) return result.data;
  const issues = result.error.issues;
  const summary = issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ");
  throw new SatiError("VALIDATION", `Invalid input: ${summary}`, { details: { issues } });
}

/** Re-validates a full record before it is stored, so services can never write a bad row. */
export function checkRecord<E extends StoredEntity>(entity: E, value: unknown): EntityMap[E] {
  return parseInput(ENTITY_SCHEMAS[entity], value);
}

export const nowIso = (ctx: Pick<ServiceContext, "clock">): string => ctx.clock.now().toISOString();

/** Drops keys whose value is `undefined`, so a patch never erases a field by accident. */
export function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function baseFields(ctx: ServiceContext, entity: StoredEntity) {
  const at = nowIso(ctx);
  return {
    id: ctx.ids(entity),
    projectId: ctx.projectId,
    createdAt: at,
    updatedAt: at,
    createdBy: ctx.actorId,
    version: 1,
    deletedAt: null,
  };
}

const PAGE = 500;

/** Every undeleted record of one entity in this project, paging past the list limit. */
export async function listAll<E extends StoredEntity>(
  r: StorageReader,
  ctx: ServiceContext,
  entity: E,
  opts: Pick<ListQuery, "includeDeleted" | "handoff"> = {},
): Promise<EntityMap[E][]> {
  const out: EntityMap[E][] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await r.list(entity, ctx.projectId, { ...opts, limit: PAGE, offset });
    out.push(...page);
    if (page.length < PAGE) return out;
  }
}

/** An actor's display name, falling back to its id. */
export async function actorName(r: StorageReader, actorId: string): Promise<string> {
  return (await r.get("actor", actorId))?.name ?? actorId;
}

/** A live (not deleted) record of this project, or NOT_FOUND. */
export async function mustGet<E extends StoredEntity>(
  r: StorageReader,
  ctx: Pick<ServiceContext, "projectId">,
  entity: E,
  id: string,
): Promise<EntityMap[E]> {
  const rec = await r.get(entity, id);
  const projectId = rec && "projectId" in rec ? rec.projectId : rec?.id;
  if (!rec || rec.deletedAt !== null || projectId !== ctx.projectId) {
    throw new SatiError("NOT_FOUND", `No ${entity} with id ${id}.`, {
      hint: `List them with \`${CLI_NAME} ${entity} list\`.`,
    });
  }
  return rec;
}

const LONG = 200;
const compact = (v: unknown): unknown =>
  typeof v === "string" && v.length > LONG ? `<${v.length} chars>` : v;

/** True for the placeholder `changes` stores in place of long text; the original is gone. */
export const isCompacted = (v: unknown): boolean =>
  typeof v === "string" && /^<\d+ chars>$/.test(v);

/** Field-level diff for the activity log. Long text is replaced by its length. */
export function changes(before: object, after: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const a = after as Record<string, unknown>;
  const b = before as Record<string, unknown>;
  // Union of keys: a patch can add an optional key that `before` does not have yet.
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (key === "version" || key === "updatedAt" || key === "stamps" || key === "lastHlc") continue;
    const from = b[key];
    const to = a[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      out[key] = { from: compact(from), to: compact(to) };
    }
  }
  return out;
}

export async function logActivity(
  w: StorageWriter,
  ctx: ServiceContext,
  verb: Verb,
  entity: StoredEntity,
  entityId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  const row: Activity = {
    id: ctx.ids("activity"),
    projectId: ctx.projectId,
    actorId: ctx.actorId,
    verb,
    entity,
    entityId,
    diff,
    branch: ctx.branch,
    at: nowIso(ctx),
  };
  await w.appendActivity(row);
}

const UNSTAMPED = new Set([
  "id",
  "projectId",
  "createdAt",
  "updatedAt",
  "createdBy",
  "version",
  "needsReview",
  "stamps",
  "lastHlc",
]);

function stampMap(value: object): Record<string, string> {
  const raw = (value as { stamps?: unknown }).stamps;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Issues one stamp for this write and remembers it on the actor. The actor row is bookkeeping:
 * it shares the transaction, and it does not get its own activity row.
 */
async function issueStamp(
  w: StorageWriter,
  ctx: ServiceContext,
  seen: readonly (string | undefined)[],
): Promise<string> {
  const actor = await w.get("actor", ctx.actorId);
  const stamp = tickHlc(ctx.clock.now(), maxHlc([actor?.lastHlc, ...seen]), ctx.actorId);
  if (actor) {
    const next = checkRecord("actor", {
      ...actor,
      lastHlc: stamp,
      updatedAt: nowIso(ctx),
      version: actor.version + 1,
    });
    await w.update("actor", next, actor.version);
  }
  return stamp;
}

function withStamps<T extends object>(value: T, keys: readonly string[], stamp: string): T {
  const stamps = stampMap(value);
  for (const key of keys) {
    if (!UNSTAMPED.has(key)) stamps[key] = stamp;
  }
  return Object.keys(stamps).length > 0 ? { ...value, stamps } : value;
}

/** Inserts a validated record and its `create` activity row. Call inside `store.write`. */
export async function insertWithLog<E extends StoredEntity>(
  w: StorageWriter,
  ctx: ServiceContext,
  entity: E,
  value: unknown,
  verb: Verb = "create",
): Promise<EntityMap[E]> {
  const raw = value !== null && typeof value === "object" ? (value as object) : {};
  const keys = Object.keys(raw);
  const stamp =
    entity === "actor" ? undefined : await issueStamp(w, ctx, Object.values(stampMap(raw)));
  const rec = checkRecord(entity, stamp ? withStamps(raw, keys, stamp) : value);
  await w.insert(entity, rec);
  const title = "title" in rec ? { title: rec.title } : {};
  await logActivity(w, ctx, verb, entity, rec.id, title);
  return rec;
}

/**
 * Applies `patch`, bumps the version and logs the diff. A patch that changes nothing writes
 * nothing. `expectedVersion` lets callers detect edits made since they last read.
 */
export async function updateWithLog<E extends StoredEntity>(
  w: StorageWriter,
  ctx: ServiceContext,
  entity: E,
  before: EntityMap[E],
  patch: object,
  opts: { verb?: Verb; expectedVersion?: number | undefined; clear?: readonly string[] } = {},
): Promise<EntityMap[E]> {
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
    throw new SatiError(
      "CONFLICT",
      `${entity} ${before.id} is at version ${before.version}, not ${opts.expectedVersion}.`,
      { hint: "Re-read the record and apply your change again." },
    );
  }
  const candidate: Record<string, unknown> = { ...before, ...defined(patch) };
  for (const key of opts.clear ?? []) delete candidate[key];
  const diff = changes(before, candidate);
  if (Object.keys(diff).length === 0) return before;
  const stamp =
    entity === "actor" || entity === "project"
      ? undefined
      : await issueStamp(w, ctx, [maxHlc(Object.values(stampMap(before)))]);
  const stamped = stamp ? withStamps(candidate, Object.keys(diff), stamp) : candidate;
  const after = checkRecord(entity, {
    ...stamped,
    updatedAt: nowIso(ctx),
    version: before.version + 1,
  });
  await w.update(entity, after, before.version);
  const verb = opts.verb ?? ("status" in diff ? "status" : "update");
  await logActivity(w, ctx, verb, entity, before.id, diff);
  return after;
}

/** Rejects a status change the entity's state machine does not allow. */
export function assertTransition<S extends string>(
  machine: Readonly<Record<S, readonly S[]>>,
  entity: StoredEntity,
  from: S,
  to: S,
): void {
  if (from === to || machine[from].includes(to)) return;
  const allowed = machine[from].join(", ") || "none";
  throw new SatiError("INVALID_TRANSITION", `A ${entity} cannot move from ${from} to ${to}.`, {
    hint: `Allowed from ${from}: ${allowed}.`,
    details: { from, to, allowed: machine[from] },
  });
}

export const ExpectedVersion = { expectedVersion: z.number().int().min(1).optional() };
