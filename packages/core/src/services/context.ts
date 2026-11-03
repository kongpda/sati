import { z } from "zod";
import { BrainError } from "../domain/errors.js";
import type { IdFactory } from "../domain/ids.js";
import {
  type Activity,
  ENTITY_SCHEMAS,
  type EntityMap,
  type StoredEntity,
  type VERBS,
} from "../domain/schemas.js";
import type { Clock } from "../ports/clock.js";
import type { StorageAdapter, StorageReader, StorageWriter } from "../ports/storage.js";

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
  throw new BrainError("VALIDATION", `Invalid input: ${summary}`, { details: { issues } });
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
    throw new BrainError("NOT_FOUND", `No ${entity} with id ${id}.`, {
      hint: `List them with \`brain ${entity} list\`.`,
    });
  }
  return rec;
}

const LONG = 200;
const compact = (v: unknown): unknown =>
  typeof v === "string" && v.length > LONG ? `<${v.length} chars>` : v;

/** Field-level diff for the activity log. Long text is replaced by its length. */
export function changes(before: object, after: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const a = after as Record<string, unknown>;
  for (const [key, from] of Object.entries(before)) {
    if (key === "version" || key === "updatedAt") continue;
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

/** Inserts a validated record and its `create` activity row. Call inside `store.write`. */
export async function insertWithLog<E extends StoredEntity>(
  w: StorageWriter,
  ctx: ServiceContext,
  entity: E,
  value: unknown,
  verb: Verb = "create",
): Promise<EntityMap[E]> {
  const rec = checkRecord(entity, value);
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
  opts: { verb?: Verb; expectedVersion?: number | undefined } = {},
): Promise<EntityMap[E]> {
  if (opts.expectedVersion !== undefined && opts.expectedVersion !== before.version) {
    throw new BrainError(
      "CONFLICT",
      `${entity} ${before.id} is at version ${before.version}, not ${opts.expectedVersion}.`,
      { hint: "Re-read the record and apply your change again." },
    );
  }
  const candidate = { ...before, ...defined(patch) };
  const diff = changes(before, candidate);
  if (Object.keys(diff).length === 0) return before;
  const after = checkRecord(entity, {
    ...candidate,
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
  throw new BrainError("INVALID_TRANSITION", `A ${entity} cannot move from ${from} to ${to}.`, {
    hint: `Allowed from ${from}: ${allowed}.`,
    details: { from, to, allowed: machine[from] },
  });
}

export const ExpectedVersion = { expectedVersion: z.number().int().min(1).optional() };
