import { isDeepStrictEqual } from "node:util";
import { mergeText } from "./diff3.js";

/** Markdown fields, merged line by line. */
const TEXT_FIELDS = new Set(["body", "description", "context", "decision", "consequences"]);
/** Set by the merge itself, not field by field. */
const META_FIELDS = new Set(["version", "updatedAt", "needsReview"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isPrimitiveList = (v: unknown): v is (string | number)[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number");

/** Orders values the same way whichever side they came from, so the merge is symmetric. */
const order = (a: Json | undefined, b: Json | undefined) => {
  const x = JSON.stringify(a) ?? "";
  const y = JSON.stringify(b) ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Three-way set merge: an item stays if both sides kept it, or one side added it. An item either
 * side removed is gone. The result is sorted, so it does not depend on which side is "ours".
 */
function mergeList(base: Json | undefined, ours: (string | number)[], theirs: (string | number)[]) {
  const had = new Set(isPrimitiveList(base) ? base : []);
  const o = new Set(ours);
  const t = new Set(theirs);
  const keep = [...new Set([...ours, ...theirs])].filter((x) =>
    had.has(x) ? o.has(x) && t.has(x) : true,
  );
  return keep.sort((a, b) => order(a, b));
}

export interface RecordMerge {
  record: Obj;
  /** A field could not be merged cleanly; the record is flagged `needsReview`. */
  conflict: boolean;
}

/**
 * Field-level three-way merge of one exported record. `base` is undefined when both sides added
 * the file. Per field: a change on one side wins; when both changed it, Markdown fields merge by
 * line, lists of strings merge as sets, and anything else takes the side with the newer
 * `updatedAt` (ties broken by value, so the result never depends on the side). The merged record
 * gets `version` one past both sides and the later `updatedAt`, so import on either clone takes it.
 */
export function mergeRecord(base: Obj | undefined, ours: Obj, theirs: Obj): RecordMerge {
  const b = base ?? {};
  const newer = order(ours.updatedAt, theirs.updatedAt) >= 0 ? ours : theirs;
  let conflict = false;
  const record: Obj = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const key of [...keys].sort()) {
    if (META_FIELDS.has(key)) continue;
    const bv = b[key];
    const ov = ours[key];
    const tv = theirs[key];
    let value: Json | undefined;
    if (isDeepStrictEqual(ov, tv) || isDeepStrictEqual(tv, bv)) value = ov;
    else if (isDeepStrictEqual(ov, bv)) value = tv;
    else if (TEXT_FIELDS.has(key) && typeof ov === "string" && typeof tv === "string") {
      const m = mergeText(typeof bv === "string" ? bv : "", ov, tv);
      value = m.text;
      conflict ||= m.conflict;
    } else if (isPrimitiveList(ov) && isPrimitiveList(tv)) value = mergeList(bv, ov, tv);
    else if (order(ours.updatedAt, theirs.updatedAt) !== 0) value = newer[key];
    else value = order(ov, tv) >= 0 ? ov : tv;
    // A field one side removed and the other left alone stays removed.
    if (value !== undefined) record[key] = value;
  }
  const versions = [ours.version, theirs.version].map((v) => (typeof v === "number" ? v : 0));
  record.version = Math.max(...versions) + 1;
  if (newer.updatedAt !== undefined) record.updatedAt = newer.updatedAt;
  if (conflict || ours.needsReview === true || theirs.needsReview === true) {
    record.needsReview = true;
  }
  return { record, conflict };
}

/** Parses one side of a merge. Only JSON parsing happens; nothing in the content is run. */
export function parseRecord(text: string, side: string): Obj {
  const value: unknown = JSON.parse(text);
  if (!isObj(value)) throw new Error(`${side} is not a JSON object`);
  return value;
}
