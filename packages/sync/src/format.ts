import { isDeepStrictEqual } from "node:util";
import { ENTITY_SCHEMAS, ID_PREFIXES, SNAPSHOT_ENTITIES, type SnapshotEntity } from "@sati/core";

/*
 * The compact form of a record in `.sati/`. Two rules shrink a file to about half:
 *
 * 1. A required field holding its empty value (null, [], "" or false, whichever its schema takes
 *    first) is left out, and put back on read.
 * 2. When most fields share one clock stamp, it is written once as `stamps["*"]`; `stamps` keeps
 *    only the stamps that differ. On read, `*` applies to every field of the record outside
 *    UNSTAMPED that has no stamp of its own.
 *
 * Both are part of the file format: changing EMPTY_CANDIDATES or UNSTAMPED changes how files
 * already in git read back. Files in the full form (written before this) read unchanged.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Tried in this order; the first value a field's schema accepts is its empty value. */
const EMPTY_CANDIDATES: readonly Json[] = [null, [], "", false];

/** Fields that never carry a stamp, so `*` does not apply to them. */
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

const SHARED = "*";

interface FieldSchema {
  safeParse(value: unknown): { success: boolean };
}

/** Each entity's required fields and their empty values, read from the Zod schemas once. */
const EMPTY: Record<SnapshotEntity, Map<string, Json>> = Object.fromEntries(
  SNAPSHOT_ENTITIES.map((entity) => {
    const shape = (ENTITY_SCHEMAS[entity] as unknown as { shape?: Record<string, FieldSchema> })
      .shape;
    const empty = new Map<string, Json>();
    for (const [key, field] of Object.entries(shape ?? {})) {
      // An optional field's absence already means something of its own; leave it alone.
      if (field.safeParse(undefined).success) continue;
      const value = EMPTY_CANDIDATES.find((v) => field.safeParse(v).success);
      if (value !== undefined) empty.set(key, value);
    }
    return [entity, empty];
  }),
) as Record<SnapshotEntity, Map<string, Json>>;

const BY_PREFIX = new Map<string, SnapshotEntity>(
  SNAPSHOT_ENTITIES.map((entity) => [ID_PREFIXES[entity], entity]),
);

/** The snapshot entity a record belongs to, from its id prefix (`tsk_…` is a task). */
export function snapshotEntityOf(record: unknown): SnapshotEntity | undefined {
  const id = isObj(record) ? record.id : undefined;
  if (typeof id !== "string") return undefined;
  return BY_PREFIX.get(id.slice(0, id.indexOf("_")));
}

const clone = (v: Json): Json => structuredClone(v);

/** The full record a file holds, in either form. Anything that is not a record passes through. */
export function decodeRecord(value: unknown): unknown {
  const entity = snapshotEntityOf(value);
  if (!entity || !isObj(value)) return value;
  const out: Obj = { ...value };
  for (const [key, empty] of EMPTY[entity]) if (!(key in out)) out[key] = clone(empty);
  const stamps = out.stamps;
  if (isObj(stamps) && typeof stamps[SHARED] === "string") {
    const shared = stamps[SHARED];
    const full: Obj = {};
    for (const key of Object.keys(out)) {
      if (!UNSTAMPED.has(key)) full[key] = shared;
    }
    for (const [key, stamp] of Object.entries(stamps)) if (key !== SHARED) full[key] = stamp;
    out.stamps = full;
  }
  return out;
}

/**
 * The most common stamp, and the stamps that must be written beside it. None when a stamped
 * field of the record has no stamp, since `*` would give it one on read.
 */
function compactStamps(record: Obj, stamps: Obj): Obj | undefined {
  if (Object.keys(record).some((key) => !UNSTAMPED.has(key) && !(key in stamps))) return undefined;
  const counts = new Map<string, number>();
  for (const v of Object.values(stamps)) {
    if (typeof v === "string") counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let shared: string | undefined;
  let best = 1;
  for (const [stamp, n] of counts) {
    if (n > best || (n === best && shared !== undefined && stamp > shared)) {
      shared = stamp;
      best = n;
    }
  }
  if (shared === undefined) return undefined;
  const out: Obj = { [SHARED]: shared };
  for (const [key, stamp] of Object.entries(stamps)) {
    // A stamp the shared one would not recreate on read is written out.
    if (stamp !== shared || !(key in record) || UNSTAMPED.has(key)) out[key] = stamp;
  }
  return out;
}

/**
 * The compact form of a record for `.sati/`. Every record is decoded again before it is written,
 * and one that would not come back exactly is written in the full form instead, so the compact
 * form can never lose a field or a stamp.
 */
export function encodeRecord(record: unknown): unknown {
  const entity = snapshotEntityOf(record);
  if (!entity || !isObj(record)) return record;
  const lean: Obj = {};
  const empty = EMPTY[entity];
  for (const [key, value] of Object.entries(record)) {
    const blank = empty.get(key);
    if (blank !== undefined && isDeepStrictEqual(value, blank)) continue;
    lean[key] = value;
  }
  const stamps = isObj(record.stamps) ? compactStamps(record, record.stamps) : undefined;
  // Smallest first: both rules, then empty fields only, then the record as it is.
  const forms = stamps ? [{ ...lean, stamps }, lean] : [lean];
  return forms.find((form) => isDeepStrictEqual(decodeRecord(form), record)) ?? record;
}
