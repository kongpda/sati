import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

// Review 4.7. The board is served from a person's own computer, but a page that grows without
// anyone noticing is a slow page. These are the gzip sizes of what `index.html` loads first, as
// measured on 2026-11-13 (docs/progress.md). Grow past 10% and this fails: either trim the
// bundle (load the heavy part with a dynamic import) or raise the number on purpose.
const BUDGET = { js: 134_010, css: 7_403 };
const GROWTH = 1.1;

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

function loadedFirst(ext: "js" | "css"): number {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const files = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/gu)]
    .map((m) => m[1] ?? "")
    .filter((f) => f.endsWith(`.${ext}`));
  expect(files.length).toBeGreaterThan(0);
  return files.reduce(
    (sum, f) => sum + gzipSync(readFileSync(join(dist, f)), { level: 9 }).length,
    0,
  );
}

describe("board bundle size", () => {
  it("the script loaded first stays within 10% of the recorded size", () => {
    expect(loadedFirst("js")).toBeLessThanOrEqual(BUDGET.js * GROWTH);
  });
  it("the style sheet stays within 10% of the recorded size", () => {
    expect(loadedFirst("css")).toBeLessThanOrEqual(BUDGET.css * GROWTH);
  });
});
