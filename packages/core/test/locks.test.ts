import { describe, expect, it } from "vitest";
import { normalizeLockPath, overlappingPaths, pathsOverlap } from "../src/index.js";

// A missed overlap lets two agents edit the same file; a false one only costs a warning or a
// refused lock. So the cases below pin both directions: what must overlap and what must not.
describe("pathsOverlap", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["src", "src/a.ts"], // a directory lock covers its files
    ["src/billing/**", "src/billing/invoice.ts"],
    ["src/billing/**", "src/billing"],
    ["src/*.ts", "src/a.ts"],
    ["src/**/*.ts", "src/a/b/c.ts"],
    ["**", "anything/at/all.md"],
    ["src/{a,b}.ts", "src/b.ts"],
    ["{src,lib}/x.ts", "lib/x.ts"],
    ["src/*.ts", "src/*.tsx"], // two globs in one segment: assumed to overlap
    ["src/*", "src/a/b.ts"], // `src/*` matches the directory src/a, so covers what is inside
    [".github/workflows/ci.yml", ".github/**"],
  ])("%s overlaps %s", (a, b) => {
    expect(pathsOverlap(a, b)).toBe(true);
    expect(pathsOverlap(b, a)).toBe(true);
  });

  it.each([
    ["src/a.ts", "src/b.ts"],
    ["src/billing/**", "src/auth/login.ts"],
    ["src/*.ts", "src/readme.md"],
    ["*.ts", "src/a.ts"], // `*` does not cross a slash
    ["src/{a,b}.ts", "src/c.ts"],
    ["srcx/a.ts", "src"], // a prefix of the name is not a parent directory
  ])("%s does not overlap %s", (a, b) => {
    expect(pathsOverlap(a, b)).toBe(false);
    expect(pathsOverlap(b, a)).toBe(false);
  });

  it("lists every overlapping pair", () => {
    expect(overlappingPaths(["src/a.ts", "docs"], ["src/**", "lib"])).toEqual([
      ["src/a.ts", "src/**"],
    ]);
  });
});

describe("normalizeLockPath", () => {
  it("makes equivalent spellings equal", () => {
    expect(normalizeLockPath(" ./src/billing/ ")).toBe("src/billing");
    expect(normalizeLockPath("src\\a.ts")).toBe("src/a.ts");
  });

  // These could never match a repo-relative file, so a lock on them would protect nothing.
  it.each(["", ".", "/etc/passwd", "C:/x", "../other/repo", "src/../../x"])("rejects %j", (p) => {
    expect(normalizeLockPath(p)).toBeUndefined();
  });
});
