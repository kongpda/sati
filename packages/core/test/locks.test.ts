import { describe, expect, it } from "vitest";
import {
  BRACE_VARIANT_CAP,
  braceVariantCount,
  globBraceError,
  normalizeLockPath,
  overlappingPaths,
  pathsOverlap,
} from "../src/index.js";

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
    // macOS and Windows open one file under either spelling, so two locks on it must collide.
    ["Docs/Report.docx", "docs/report.docx"],
    ["r\u00e9sum\u00e9.xlsx", "re\u0301sume\u0301.xlsx"], // one name, composed and decomposed
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

  // Why: `src/./a.ts` kept its `.` segment, so a lock written that way did not cover `src/a.ts`
  // and a second agent could lock and edit the same file.
  it("drops `.` segments, so both spellings of one file overlap", () => {
    expect(normalizeLockPath("src/./a.ts")).toBe("src/a.ts");
    expect(normalizeLockPath("./././src/a.ts")).toBe("src/a.ts");
    expect(pathsOverlap(normalizeLockPath("src/./a.ts") ?? "", "src/a.ts")).toBe(true);
    // A dot inside a name is not a segment.
    expect(normalizeLockPath("src/.env")).toBe("src/.env");
  });

  // These could never match a repo-relative file, so a lock on them would protect nothing.
  it.each(["", ".", "/etc/passwd", "C:/x", "../other/repo", "src/../../x"])("rejects %j", (p) => {
    expect(normalizeLockPath(p)).toBeUndefined();
  });
});

describe("braceVariantCount", () => {
  // The count guards every lock and feature path against brace bombs, so it must agree with
  // real expansion on ordinary globs and never under-count a hostile one.
  it("counts lists, nested lists, numeric and letter ranges, and steps", () => {
    expect(braceVariantCount("src/**/*.ts")).toBe(1);
    expect(braceVariantCount("src/{a,b}/{c,d,e}")).toBe(6);
    expect(braceVariantCount("{a,{b,c}}")).toBe(3);
    expect(braceVariantCount("f{1..10}")).toBe(10);
    expect(braceVariantCount("f{0..10..5}")).toBe(3);
    expect(braceVariantCount("{a..e}")).toBe(5);
    expect(braceVariantCount("{a..e..2}")).toBe(3);
  });

  it("ignores escaped and unclosed braces", () => {
    expect(braceVariantCount("a\\{b,c\\}")).toBe(1);
    expect(braceVariantCount("{a\\,b,c}")).toBe(2);
    expect(braceVariantCount("src/{a,b")).toBe(1);
  });

  it("saturates just above the cap instead of overflowing", () => {
    expect(braceVariantCount("{a,b}".repeat(200))).toBe(BRACE_VARIANT_CAP + 1);
    expect(braceVariantCount("{1..5000}")).toBe(BRACE_VARIANT_CAP + 1);
    expect(globBraceError("src/{a,b}")).toBeUndefined();
    expect(globBraceError(`${"x".repeat(70)}{1..5000}`)).toContain("...");
  });
});
