import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NAME } from "../src/name.js";
import { WORKFLOW } from "../src/workflow.js";

// PLAN Phase 5: the `sati://workflow` resource is generated from the docs site's agent workflow
// page. If the two drift, agents follow rules the docs no longer describe, or the reverse.

const doc = fileURLToPath(new URL("../../../docs/guide/agent-workflow.md", import.meta.url));
const script = fileURLToPath(new URL("../scripts/gen-workflow.mjs", import.meta.url));

describe("WORKFLOW", () => {
  it("is the docs page, with the product name filled in", () => {
    const page = readFileSync(doc, "utf8").replace(
      /(?<![A-Za-z0-9])sati(?![A-Za-z0-9])/gu,
      CLI_NAME,
    );
    expect(WORKFLOW).toBe(page);
  });

  it("src/workflow.ts is what the generator writes", () => {
    expect(() =>
      execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });
});
