import { describe, expect, it } from "vitest";
import type { Snapshot } from "../src/api.js";
import { parentKind } from "../src/api.js";

// A comment is a note that links to what it is on. The page it opens depends on that record's
// kind, which the loaded records know. The id's prefix is only a guess for a record not loaded.
const data = {
  tasks: [{ id: "tsk_a" }],
  decisions: [{ id: "weird-decision-id" }],
  notes: [{ id: "weird-note-id" }],
} as unknown as Snapshot;

describe("parentKind", () => {
  it("takes the kind from the loaded record, not from the id", () => {
    expect(parentKind(data, "weird-decision-id")).toBe("decision");
    expect(parentKind(data, "weird-note-id")).toBe("note");
    expect(parentKind(data, "tsk_a")).toBe("task");
  });
  it("falls back to the prefix for a record that is not loaded", () => {
    expect(parentKind(data, "dec_unloaded")).toBe("decision");
    expect(parentKind(data, "tsk_unloaded")).toBe("task");
    expect(parentKind(data, "note_unloaded")).toBe("note");
  });
});
