import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { startUi, type Ui } from "./server.js";

let ui: Ui;
let taskId = "";
test.beforeAll(async () => {
  ui = await startUi();
  // Content on every page, so axe checks real rows and not only empty states.
  const feature = ui.sati<{ id: string }>(
    "feature",
    "create",
    "Search",
    "--acceptance",
    "Finds tasks",
  );
  const task = await ui.api<{ id: string }>("POST", "/api/tasks", {
    title: "Index note bodies",
    body: "Search should cover `notes` too.",
    featureId: feature.id,
  });
  await ui.api("POST", "/api/tasks", { title: "Plain task" });
  await ui.api("POST", "/api/notes", {
    title: "Search design",
    body: "## Flow\n\n```mermaid\nflowchart LR\n  Q[query] --> I[index]\n```",
  });
  await ui.api("POST", "/api/decisions", {
    title: "Use FTS5",
    context: "We need search.",
    decision: "Use SQLite FTS5.",
  });
  ui.sati("milestone", "create", "1.0");
  taskId = task.id;
});
test.afterAll(async () => {
  await ui?.stop();
});

const PAGES = ["/", "/agents", "/roadmap", "/features", "/notes", "/decisions", "/activity"];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

for (const [device, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["phone", { width: 375, height: 812 }],
] as const) {
  test.describe(device, () => {
    test.use({ viewport });

    // PLAN Phase 4: axe finds no WCAG 2.2 AA issue on any page. The plan bar is no serious or
    // critical issue; this also holds the moderate ones at zero.
    for (const path of PAGES) {
      test(`axe: ${path}`, async ({ page }) => {
        await page.goto(ui.signIn);
        if (path !== "/")
          await page.getByRole("link", { name: navName(path), exact: true }).click();
        await page.waitForLoadState("networkidle");
        if (path === "/notes")
          await expect(page.locator(".mermaid[data-ready=true]")).toBeVisible();
        const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const best = await new AxeBuilder({ page }).withTags(["best-practice"]).analyze();
        expect(summary(best.violations)).toEqual([]);
        expect(summary(result.violations)).toEqual([]);
      });
    }

    test("axe: task sheet and search palette", async ({ page }) => {
      await page.goto(ui.signIn);
      await page.goto(`${ui.origin}/?task=${taskId}`);
      await expect(page.getByRole("dialog", { name: "Index note bodies" })).toBeVisible();
      const sheet = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(sheet.violations)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      await expect(page.getByRole("dialog", { name: "Search" })).toBeVisible();
      const palette = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(palette.violations)).toEqual([]);
    });
  });
}

function navName(path: string): string {
  const name = path.slice(1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Every issue, one line each, so a failure says what to fix. */
function summary(
  violations: { id: string; impact?: string | null; nodes: { target: unknown }[] }[],
) {
  return violations.map(
    (v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => JSON.stringify(n.target)).join(", ")}`,
  );
}
