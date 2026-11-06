import { describe, expect, it } from "vitest";
import { parseShellChanges } from "../src/index.js";

describe("parseShellChanges", () => {
  // PLAN: PreToolUse matches Bash and turns rm, git rm and mv into guard changes.
  it("reads deletes and renames through flags, quotes and chains", () => {
    expect(parseShellChanges("rm -rf -- src/a.ts 'src/b c.ts'")).toEqual([
      { path: "src/a.ts", kind: "deleted" },
      { path: "src/b c.ts", kind: "deleted" },
    ]);
    expect(parseShellChanges("git rm -f src/a.ts && mv src/old.ts src/new.ts")).toEqual([
      { path: "src/a.ts", kind: "deleted" },
      { path: "src/new.ts", kind: "renamed", from: "src/old.ts" },
    ]);
    expect(parseShellChanges("mv src/a.ts src/b.ts dest/")).toEqual([
      { path: "dest/a.ts", kind: "renamed", from: "src/a.ts" },
      { path: "dest/b.ts", kind: "renamed", from: "src/b.ts" },
    ]);
  });

  it("ignores commands it does not understand", () => {
    expect(parseShellChanges("echo rm src/a.ts")).toEqual([]);
    expect(parseShellChanges("git status && ls")).toEqual([]);
    expect(parseShellChanges("mv only-one")).toEqual([]);
  });

  it("keeps quoted, escaped and wrapped commands", () => {
    expect(
      parseShellChanges('rm "src/a.ts"; sudo rm src/b.ts\nFOO=1 rm src/c.ts || git rm -- -d'),
    ).toEqual([
      { path: "src/a.ts", kind: "deleted" },
      { path: "src/b.ts", kind: "deleted" },
      { path: "src/c.ts", kind: "deleted" },
      { path: "-d", kind: "deleted" },
    ]);
    expect(parseShellChanges("rm path\\ with\\ space | true")).toEqual([
      { path: "path with space", kind: "deleted" },
    ]);
    expect(parseShellChanges("mv src/a.ts .")).toEqual([
      { path: "a.ts", kind: "renamed", from: "src/a.ts" },
    ]);
  });
});
