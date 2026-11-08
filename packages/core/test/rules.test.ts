import { describe, expect, it } from "vitest";
import { findDependencyCycle } from "../src/domain/rules.js";

const graph = (g: Record<string, string[]>) => (id: string) => g[id];

describe("findDependencyCycle", () => {
  it("accepts an acyclic graph", () => {
    expect(findDependencyCycle("a", ["b"], graph({ b: ["c"], c: [] }))).toBeUndefined();
  });

  it("rejects a self dependency", () => {
    expect(findDependencyCycle("a", ["a"], graph({}))).toEqual(["a", "a"]);
  });

  it("reports the full path of an indirect cycle", () => {
    expect(findDependencyCycle("a", ["b"], graph({ b: ["c"], c: ["a"] }))).toEqual([
      "a",
      "b",
      "c",
      "a",
    ]);
  });

  it("ignores cycles that do not pass through the edited task", () => {
    expect(findDependencyCycle("a", ["b"], graph({ b: ["c"], c: ["b"] }))).toBeUndefined();
  });

  it("handles diamonds without false positives", () => {
    expect(
      findDependencyCycle("a", ["b", "c"], graph({ b: ["d"], c: ["d"], d: [] })),
    ).toBeUndefined();
  });
});
