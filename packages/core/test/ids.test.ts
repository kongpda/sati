import { describe, expect, it } from "vitest";
import {
  createIdFactory,
  entityForPrefix,
  isIdOf,
  parseHandle,
  parseId,
  shortHandle,
} from "../src/domain/ids.js";

describe("ids", () => {
  it("creates prefixed ULIDs", () => {
    const id = createIdFactory()("task");
    expect(id).toMatch(/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isIdOf("task", id)).toBe(true);
    expect(isIdOf("feature", id)).toBe(false);
  });

  // IDs from different worktrees must sort by creation time and never clash.
  it("is sortable and unique within the same millisecond", () => {
    const make = createIdFactory(() => 1_700_000_000_000);
    const ids = Array.from({ length: 1000 }, () => make("task"));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });

  it("builds a short lowercase handle from the random part", () => {
    const id = "tsk_01JC0000000000000000ABCDEF";
    expect(shortHandle(id)).toBe("tsk_abcdef");
    expect(shortHandle("not-an-id")).toBe("not-an-id");
  });

  it("parses handles case-insensitively and rejects junk", () => {
    expect(parseHandle("TSK_AbCdEf")).toEqual({ prefix: "tsk", suffix: "ABCDEF" });
    expect(parseHandle("tsk_")).toBeUndefined();
    expect(parseHandle("tsk_ab")).toBeUndefined();
    expect(parseHandle("tsk_abc!de")).toBeUndefined();
  });

  it("parses full ids and maps prefixes back to entities", () => {
    expect(parseId("feat_01JC0000000000000000ABCDEF")?.prefix).toBe("feat");
    expect(parseId("feat_short")).toBeUndefined();
    expect(parseId("_01JC0000000000000000ABCDEF")).toBeUndefined();
    expect(entityForPrefix("dec")).toBe("decision");
    expect(entityForPrefix("zzz")).toBeUndefined();
  });
});
