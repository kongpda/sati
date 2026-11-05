import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mergeRecord, mergeText } from "../src/index.js";

const T1 = "2026-11-03T12:00:00.000Z";
const T2 = "2026-11-03T13:00:00.000Z";
const T3 = "2026-11-03T14:00:00.000Z";
const STAMP = "2026-11-03T12:00:00.000Z#000000#writer";

const task = {
  id: "tsk_1",
  title: "Base",
  status: "todo",
  labels: ["a", "b"],
  body: "one\ntwo\nthree",
  version: 2,
  updatedAt: T1,
  deletedAt: null,
};

describe("mergeText", () => {
  it("applies edits to different lines from both sides", () => {
    expect(mergeText("one\ntwo\nthree", "ONE\ntwo\nthree", "one\ntwo\nTHREE")).toEqual({
      text: "ONE\ntwo\nTHREE",
      conflict: false,
    });
  });

  it("takes an identical edit once", () => {
    expect(mergeText("a\nb", "a\nx\nb", "a\nx\nb")).toEqual({ text: "a\nx\nb", conflict: false });
  });

  // PLAN: a body conflict keeps both versions under conflict markers; the merge never fails.
  it("keeps both versions between markers when the same line changed differently", () => {
    expect(mergeText("a\nb\nc", "a\nours\nc", "a\ntheirs\nc")).toEqual({
      text: "a\n<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\nc",
      conflict: true,
    });
  });
});

describe("mergeRecord", () => {
  it("takes each side's change to different fields", () => {
    const r = mergeRecord(
      task,
      { ...task, title: "Ours", version: 3, updatedAt: T2 },
      { ...task, status: "doing", version: 3, updatedAt: T3 },
    );
    expect(r).toEqual({
      record: { ...task, title: "Ours", status: "doing", version: 4, updatedAt: T3 },
      conflict: false,
    });
  });

  // PLAN: if both changed a field, the newer updatedAt wins for scalars.
  it("lets the newer side win a scalar both sides changed", () => {
    const r = mergeRecord(
      task,
      { ...task, title: "Older", updatedAt: T3 },
      { ...task, title: "Newer", updatedAt: T2 },
    );
    expect(r.record.title).toBe("Older");
  });

  // PLAN: arrays are unioned. A label removed on one side must not come back from the other.
  it("merges lists as sets: additions from both sides, removals stick", () => {
    const r = mergeRecord(
      task,
      { ...task, labels: ["a", "b", "x"] },
      { ...task, labels: ["b", "y"] },
    );
    expect(r.record.labels).toEqual(["b", "x", "y"]);
  });

  it("flags needsReview on a body conflict and bumps the version past both sides", () => {
    const r = mergeRecord(
      task,
      { ...task, body: "one\nOURS\nthree", version: 3 },
      { ...task, body: "one\nTHEIRS\nthree", version: 5 },
    );
    expect(r.conflict).toBe(true);
    expect(r.record).toMatchObject({ needsReview: true, version: 6 });
    expect(r.record.body).toContain("<<<<<<< ours");
  });

  it("merges a file both sides added, with no base", () => {
    const r = mergeRecord(undefined, { ...task, body: "x" }, { ...task, body: "y" });
    expect(r.conflict).toBe(true);
    expect(r.record.title).toBe("Base");
  });

  it("keeps a needsReview flag from either side", () => {
    const r = mergeRecord(task, { ...task, needsReview: true }, task);
    expect(r.record.needsReview).toBe(true);
  });

  // PLAN: a clone whose wall clock is behind would win under updatedAt. The later HLC wins instead.
  it("prefers a later field stamp when that side's updatedAt is older", () => {
    const ahead = "2026-11-03T14:00:00.000Z#000000#clock-ahead";
    const behind = "2026-11-03T14:00:00.000Z#000001#clock-behind";
    const r = mergeRecord(
      task,
      { ...task, title: "Wall clock ahead", updatedAt: T3, stamps: { title: ahead } },
      { ...task, title: "Saw the other stamp", updatedAt: T2, stamps: { title: behind } },
    );
    expect(r.record.title).toBe("Saw the other stamp");
    expect(r.record.stamps).toMatchObject({ title: behind });
  });

  it("still uses updatedAt when either side has no stamp for the field", () => {
    const r = mergeRecord(
      task,
      { ...task, title: "Stamped but older wall", updatedAt: T2, stamps: { title: STAMP } },
      { ...task, title: "Unstamped later wall", updatedAt: T3 },
    );
    expect(r.record.title).toBe("Unstamped later wall");
  });

  // PLAN: a newer edit revives a delete and flags review; an older edit stays deleted.
  it("revives a deleted record when the edit stamp is newer", () => {
    const r = mergeRecord(
      task,
      {
        ...task,
        deletedAt: T2,
        updatedAt: T3,
        stamps: { deletedAt: "2026-11-03T14:00:00.000Z#000000#delete" },
      },
      {
        ...task,
        title: "Still needed",
        updatedAt: T2,
        stamps: { title: "2026-11-03T14:00:00.000Z#000001#edit" },
      },
    );
    expect(r.record.deletedAt).toBeNull();
    expect(r.record.title).toBe("Still needed");
    expect(r.record.needsReview).toBe(true);
    expect(r.conflict).toBe(true);
  });

  it("keeps the delete when it is newer than the edit, or the clocks tie", () => {
    const deleted = {
      ...task,
      deletedAt: T3,
      updatedAt: T2,
      stamps: { deletedAt: "2026-11-03T14:00:00.000Z#000002#delete" },
    };
    const edited = {
      ...task,
      title: "Older edit",
      updatedAt: T3,
      stamps: { title: "2026-11-03T14:00:00.000Z#000001#edit" },
    };
    const r = mergeRecord(task, edited, deleted);
    expect(r.record.deletedAt).toBe(T3);
    expect(r.record.needsReview).toBeUndefined();
    const tie = mergeRecord(
      task,
      { ...task, title: "Edit", updatedAt: T2 },
      { ...task, deletedAt: T2, updatedAt: T2 },
    );
    expect(tie.record.deletedAt).toBe(T2);
    expect(tie.record.needsReview).toBeUndefined();
  });
});

// PLAN: property tests. Merging is deterministic, merge(A, B) equals merge(B, A) for
// non-conflicting edits, and no edit is lost.
describe("merge properties", () => {
  const line = (prefix: string) => fc.constantFrom(...["1", "2", "3", "4"].map((n) => prefix + n));
  const lines = (prefix: string) => fc.array(line(prefix), { maxLength: 6 });
  const labels = fc.uniqueArray(fc.constantFrom("a", "b", "c", "d", "e"), { maxLength: 5 });
  const side = fc.record({
    title: fc.constantFrom("t1", "t2", "t3"),
    status: fc.constantFrom("todo", "doing", "done"),
    labels,
    body: fc.array(fc.constantFrom("x", "y", "z", ""), { maxLength: 5 }).map((l) => l.join("\n")),
    updatedAt: fc.constantFrom(T1, T2, T3),
    version: fc.integer({ min: 1, max: 9 }),
  });

  it("is deterministic and symmetric whenever there is no conflict", () => {
    fc.assert(
      fc.property(side, side, side, (b, o, t) => {
        const ab = mergeRecord(b, o, t);
        expect(mergeRecord(b, o, t)).toEqual(ab);
        if (!ab.conflict) expect(mergeRecord(b, t, o).record).toEqual(ab.record);
      }),
      { numRuns: 2000 },
    );
  });

  it("never loses a change made on one side only, or a label either side added", () => {
    fc.assert(
      fc.property(side, side, side, (b, o, t) => {
        const { record } = mergeRecord(b, o, t);
        for (const key of ["title", "status", "body"] as const) {
          if (t[key] === b[key]) expect(record[key]).toEqual(o[key]);
          if (o[key] === b[key]) expect(record[key]).toEqual(t[key]);
        }
        for (const l of [...o.labels, ...t.labels]) {
          if (!b.labels.includes(l)) expect(record.labels).toContain(l);
        }
        expect(record.version).toBe(Math.max(o.version, t.version) + 1);
      }),
      { numRuns: 2000 },
    );
  });

  // Edits on either side of a line both keep apply cleanly, in either order.
  it("merges edits on separate regions of a body without conflict", () => {
    fc.assert(
      fc.property(lines("a"), lines("a"), lines("b"), lines("b"), (a, a2, bb, b2) => {
        const join = (x: string[], y: string[]) => [...x, "SEP", ...y].join("\n");
        const r = mergeText(join(a, bb), join(a2, bb), join(a, b2));
        expect(r).toEqual({ text: join(a2, b2), conflict: false });
      }),
      { numRuns: 2000 },
    );
  });
});
