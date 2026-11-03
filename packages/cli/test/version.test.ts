import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const bin = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("brain --version", () => {
  // Phase 0 gate: the published binary must start and report the package version.
  it("prints the package version from the built bundle", () => {
    const out = execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(pkg.version);
  });
});
