import { monotonicFactory } from "ulid";

export const ID_PREFIXES = {
  project: "prj",
  milestone: "mil",
  feature: "feat",
  task: "tsk",
  lock: "lck",
  decision: "dec",
  note: "note",
  context: "ctx",
  activity: "act",
  actor: "actr",
} as const;

export type EntityName = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[EntityName];

const HANDLE_LEN = 6;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type IdFactory = (entity: EntityName) => string;

/** Monotonic ULIDs keep IDs sortable even when many are made in the same millisecond. */
export function createIdFactory(now: () => number = Date.now): IdFactory {
  const next = monotonicFactory();
  return (entity) => `${ID_PREFIXES[entity]}_${next(now())}`;
}

export function parseId(id: string): { prefix: string; ulid: string } | undefined {
  const sep = id.indexOf("_");
  if (sep <= 0) return undefined;
  const prefix = id.slice(0, sep);
  const ulid = id.slice(sep + 1);
  if (!ULID_RE.test(ulid)) return undefined;
  return { prefix, ulid };
}

/**
 * Short display handle, e.g. `tsk_8f3k2a`: the prefix plus the last 6 characters
 * (random part) of the ULID, lowercased. Not guaranteed unique; lookups must
 * report ambiguity.
 */
export function shortHandle(id: string): string {
  const parsed = parseId(id);
  if (!parsed) return id;
  return `${parsed.prefix}_${parsed.ulid.slice(-HANDLE_LEN).toLowerCase()}`;
}

/** Matches `tsk_8f3k2a` style input (case-insensitive). */
export function parseHandle(input: string): { prefix: string; suffix: string } | undefined {
  const m = /^([a-z]+)_([0-9a-hjkmnp-tv-z]{4,25})$/i.exec(input);
  if (!m?.[1] || !m[2]) return undefined;
  return { prefix: m[1].toLowerCase(), suffix: m[2].toUpperCase() };
}
