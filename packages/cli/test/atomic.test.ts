import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/atomic.js";

describe("writeFileAtomic", () => {
  // Why: hooks and config were written in place, so a crash mid-write left a truncated file that
  // git or sati then tried to run or parse; a rename leaves either the old or the new file.
  it("replaces the file via rename, keeps its mode and leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-atomic-"));
    const path = join(dir, "hook");
    writeFileSync(path, "old");
    chmodSync(path, 0o755);
    writeFileAtomic(path, "new", 0o644);
    expect(readFileSync(path, "utf8")).toBe("new");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual(["hook"]);
  });
});
