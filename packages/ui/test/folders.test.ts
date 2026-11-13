import { describe, expect, it } from "vitest";
import { groupByFolder } from "../src/memory.js";

describe("groupByFolder", () => {
  it("keeps every card and the order inside a folder", () => {
    const cards = [
      { path: "src/b.ts" },
      { path: "README.md" },
      { path: "src/a.ts" },
      { path: "docs/x.md" },
      { path: "src/c.ts" },
    ];
    const grouped = groupByFolder(cards);
    expect([...grouped.values()].flat()).toHaveLength(cards.length);
    expect(grouped.get("src")?.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
  it("does not change the list it is given", () => {
    const cards = [{ path: "b/x" }, { path: "a/x" }];
    groupByFolder(cards);
    expect(cards.map((c) => c.path)).toEqual(["b/x", "a/x"]);
  });
});
