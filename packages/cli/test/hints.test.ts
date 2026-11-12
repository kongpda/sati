import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import decision from "../src/commands/decision.js";

// PLAN Errors: every error carries a hint with the next step. A hint that names a flag the command
// does not have sends the agent down a dead end: citty ignores unknown flags, so
// `decision record --feature X` records a decision that is linked to no feature, and the guard
// keeps blocking.

const packages = fileURLToPath(new URL("../../", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

describe("hints", () => {
  it("name only flags that `decision record` has", async () => {
    const subs = decision.subCommands as Record<string, { args?: Record<string, unknown> }>;
    const flags = Object.keys(subs.record?.args ?? {});
    expect(flags).toContain("feature");
    const used = new Set<string>();
    for (const pkg of readdirSync(packages)) {
      let files: string[] = [];
      try {
        files = sources(join(packages, pkg, "src"));
      } catch {
        continue;
      }
      for (const file of files) {
        for (const m of readFileSync(file, "utf8").matchAll(/decision record --([a-z-]+)/gu)) {
          if (m[1]) used.add(m[1]);
        }
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const flag of used) expect(flags).toContain(flag);
  });
});
