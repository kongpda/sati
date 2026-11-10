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
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../src/atomic.js";

// Lets a test make renameSync fail the way Windows does when another process has the file open.
const fail = vi.hoisted(() => ({ times: 0 }));
vi.mock("node:fs", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (fail.times > 0) {
        fail.times--;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      }
      fs.renameSync(from, to);
    },
  };
});

afterEach(() => {
  fail.times = 0;
});

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

  // Why: on Windows a rename over a file another process has open (an editor, an antivirus scan)
  // fails with EPERM for a moment. One failure must not fail `sati init`, and a failure that
  // lasts must not leave a `.tmp` file behind in the repo.
  it("retries a rename that fails with EPERM, and cleans up when it keeps failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-atomic-"));
    const path = join(dir, "config.json");
    writeFileSync(path, "old");
    fail.times = 2;
    writeFileAtomic(path, "new");
    expect(readFileSync(path, "utf8")).toBe("new");
    fail.times = 1000;
    expect(() => writeFileAtomic(path, "newer")).toThrow(/EPERM/u);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });
});
