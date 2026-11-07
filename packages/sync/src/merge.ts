import { isDeepStrictEqual } from "node:util";
import { compareHlc } from "@sati/core";
import { mergeText } from "./diff3.js";

/** Markdown fields, merged line by line. */
const TEXT_FIELDS = new Set(["body", "description", "context", "decision", "consequences"]);
/** Set by the merge itself, not field by field. */
const META_FIELDS = new Set(["version", "updatedAt", "needsReview", "stamps"]);

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

function fieldStamp(rec: Obj, key: string): string | undefined {
  const stamps = rec.stamps;
  if (!isObj(stamps)) return undefined;
  const stamp = stamps[key];
  return typeof stamp === "string" ? stamp : undefined;
}

/**
 * Which side wrote `key` later. Both stamps present: hybrid logical clock. Otherwise `updatedAt`,
 * so records written before stamps still merge. A tie is reported as `"tie"`.
 */
function laterSide(ours: Obj, theirs: Obj, key: string): "ours" | "theirs" | "tie" {
  const os = fieldStamp(ours, key);
  const ts = fieldStamp(theirs, key);
  const cmp = os && ts ? compareHlc(os, ts) : order(ours.updatedAt, theirs.updatedAt);
  if (cmp > 0) return "ours";
  if (cmp < 0) return "theirs";
  return "tie";
}

function remember(stamps: Obj, key: string, stamp: string | undefined) {
  if (stamp) stamps[key] = stamp;
}

/** True when the edit's clock is strictly after the delete. Missing stamps fall back to `updatedAt`. */
function editBeatsDelete(editor: Obj, deleter: Obj, key: string): boolean {
  const editStamp = fieldStamp(editor, key);
  const deleteStamp = fieldStamp(deleter, "deletedAt");
  if (editStamp && deleteStamp) return compareHlc(editStamp, deleteStamp) > 0;
  return order(editor.updatedAt, deleter.updatedAt) > 0;
}

/**
 * A delete on one side and edits on the other. The newer event wins: a newer edit clears
 * `deletedAt` and flags `needsReview`; otherwise the record stays deleted. Equal clocks keep
 * the delete.
 */
function resolveDelete(
  base: Obj,
  ours: Obj,
  theirs: Obj,
  record: Obj,
  stamps: Obj,
): { review: boolean } {
  const oursDeleted = ours.deletedAt != null && !isDeepStrictEqual(ours.deletedAt, base.deletedAt);
  const theirsDeleted =
    theirs.deletedAt != null && !isDeepStrictEqual(theirs.deletedAt, base.deletedAt);
  if (oursDeleted === theirsDeleted) return { review: false };
  const deleter = oursDeleted ? ours : theirs;
  const editor = oursDeleted ? theirs : ours;
  const edited = Object.keys(editor).filter(
    (key) =>
      !META_FIELDS.has(key) && key !== "deletedAt" && !isDeepStrictEqual(editor[key], base[key]),
  );
  if (edited.length === 0) return { review: false };
  const winning = edited.filter((key) => editBeatsDelete(editor, deleter, key));
  if (winning.length === 0) {
    if (deleter.deletedAt !== undefined) record.deletedAt = deleter.deletedAt;
    remember(stamps, "deletedAt", fieldStamp(deleter, "deletedAt"));
    return { review: false };
  }
  record.deletedAt = null;
  delete stamps.deletedAt;
  return { review: true };
}

/**
 * Field-level three-way merge of one exported record. `base` is undefined when both sides added
 * the file. Per field: a change on one side wins; when both changed it, Markdown fields merge by
 * line, lists of strings merge as sets, and anything else takes the side with the later per-field
 * HLC stamp (records with no stamp fall back to `updatedAt`; ties broken by value, so the result
 * never depends on the side). The merged record gets `version` one past both sides and the later
 * `updatedAt`, so import on either clone takes it.
 */
export function mergeRecord(base: Obj | undefined, ours: Obj, theirs: Obj): RecordMerge {
  const b = base ?? {};
  const newer = order(ours.updatedAt, theirs.updatedAt) >= 0 ? ours : theirs;
  let conflict = false;
  const record: Obj = {};
  const stamps: Obj = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  for (const key of [...keys].sort()) {
    // Keys come from files anyone can push; assigning "__proto__" would swap the record's prototype.
    if (META_FIELDS.has(key) || key === "__proto__") continue;
    const bv = b[key];
    const ov = ours[key];
    const tv = theirs[key];
    let value: Json | undefined;
    let stamp: string | undefined;
    if (key === "lastHlc" && typeof ov === "string" && typeof tv === "string") {
      value = compareHlc(ov, tv) >= 0 ? ov : tv;
      stamp = value;
    } else if (isDeepStrictEqual(ov, tv)) {
      value = ov;
      stamp = fieldStamp(ours, key) ?? fieldStamp(theirs, key);
    } else if (
      // A side whose value matches the base may still have written it since: a claim that was
      // set and then cleared looks unchanged. With stamps on both sides, the later write wins.
      !TEXT_FIELDS.has(key) &&
      !(isPrimitiveList(ov) && isPrimitiveList(tv)) &&
      fieldStamp(ours, key) &&
      fieldStamp(theirs, key) &&
      laterSide(ours, theirs, key) !== "tie"
    ) {
      const winner = laterSide(ours, theirs, key) === "ours" ? ours : theirs;
      value = winner[key];
      stamp = fieldStamp(winner, key);
    } else if (isDeepStrictEqual(tv, bv)) {
      value = ov;
      stamp = fieldStamp(ours, key) ?? fieldStamp(theirs, key);
    } else if (isDeepStrictEqual(ov, bv)) {
      value = tv;
      stamp = fieldStamp(theirs, key);
    } else if (TEXT_FIELDS.has(key) && typeof ov === "string" && typeof tv === "string") {
      const m = mergeText(typeof bv === "string" ? bv : "", ov, tv);
      value = m.text;
      conflict ||= m.conflict;
      const side = laterSide(ours, theirs, key);
      stamp = fieldStamp(side === "theirs" ? theirs : ours, key);
    } else if (isPrimitiveList(ov) && isPrimitiveList(tv)) {
      value = mergeList(bv, ov, tv);
      const side = laterSide(ours, theirs, key);
      stamp = fieldStamp(side === "theirs" ? theirs : ours, key);
    } else {
      const side = laterSide(ours, theirs, key);
      const winner =
        side === "tie" ? (order(ov, tv) >= 0 ? ours : theirs) : side === "ours" ? ours : theirs;
      value = winner[key];
      stamp = fieldStamp(winner, key);
    }
    // A field one side removed and the other left alone stays removed.
    if (value !== undefined) record[key] = value;
    remember(stamps, key, stamp);
  }
  const revived = resolveDelete(b, ours, theirs, record, stamps);
  const versions = [ours.version, theirs.version].map((v) => (typeof v === "number" ? v : 0));
  record.version = Math.max(...versions) + 1;
  if (newer.updatedAt !== undefined) record.updatedAt = newer.updatedAt;
  if (Object.keys(stamps).length > 0) record.stamps = stamps;
  if (conflict || revived.review || ours.needsReview === true || theirs.needsReview === true) {
    record.needsReview = true;
  }
  return { record, conflict: conflict || revived.review };
}

/** Parses one side of a merge. Only JSON parsing happens; nothing in the content is run. */
export function parseRecord(text: string, side: string): Obj {
  const value: unknown = JSON.parse(text);
  if (!isObj(value)) throw new Error(`${side} is not a JSON object`);
  return value;
}
