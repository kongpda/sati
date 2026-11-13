import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { openKnowledge } from "./nav.js";
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
  ui.sati(
    "card",
    "put",
    "docs/search.md",
    "--summary",
    "How search ranks hits",
    "--facts",
    "Uses FTS5",
  );
  taskId = task.id;
});
test.afterAll(async () => {
  await ui?.stop();
});

const PAGES = [
  "/",
  "/my-work",
  "/plan",
  "/plan?tab=features",
  "/knowledge",
  "/knowledge?kind=decisions",
  "/knowledge?kind=cards",
  "/changes",
  "/changes?tab=log",
  "/team",
  "/settings",
];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Each size runs in both themes: contrast is checked against the dark tokens too.
for (const [device, viewport, colorScheme] of [
  ["desktop", { width: 1280, height: 800 }, "light"],
  ["phone", { width: 375, height: 812 }, "light"],
  ["desktop dark", { width: 1280, height: 800 }, "dark"],
  ["phone dark", { width: 375, height: 812 }, "dark"],
] as const) {
  test.describe(device, () => {
    test.use({ viewport, colorScheme });

    // PLAN Phase 4: axe finds no WCAG 2.2 AA issue on any page. The plan bar is no serious or
    // critical issue; this also holds the moderate ones at zero.
    for (const path of PAGES) {
      test(`axe: ${path}`, async ({ page }) => {
        await page.goto(ui.signIn);
        if (path !== "/") {
          const [base = path, query] = path.split("?");
          await page.getByRole("link", { name: navName(base), exact: true }).click();
          if (query === "tab=log")
            await page.getByRole("tab", { name: "Log", exact: true }).click();
          if (query === "kind=decisions")
            await page.getByRole("tab", { name: "Decisions", exact: true }).click();
          if (query === "kind=cards")
            await page.getByRole("tab", { name: "File cards", exact: true }).click();
          if (query === "tab=features")
            await page.getByRole("tab", { name: "Features", exact: true }).click();
        }
        await page.waitForLoadState("networkidle");
        if (path === "/knowledge")
          await expect(page.locator(".mermaid[data-ready=true]")).toBeVisible();
        // PLAN: UX works at 375 px. Every control in the top bar stays on screen.
        const search = await page
          .getByRole("button", { name: "Search", exact: true })
          .boundingBox();
        expect(search && search.x + search.width).toBeLessThanOrEqual(viewport.width);
        const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const best = await new AxeBuilder({ page }).withTags(["best-practice"]).analyze();
        expect(summary(best.violations)).toEqual([]);
        expect(summary(result.violations)).toEqual([]);
      });
    }

    test("axe: task sheet, search palette and new task form", async ({ page }) => {
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
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "New task" }).click();
      await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
      const form = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(form.violations)).toEqual([]);
    });

    test("axe: milestone, decision, note, card and person forms", async ({ page }) => {
      await page.goto(ui.signIn);
      await page.getByRole("link", { name: "Plan", exact: true }).click();
      await page.getByRole("button", { name: "Edit 1.0" }).click();
      await expect(page.getByRole("dialog", { name: "Edit milestone" })).toBeVisible();
      const milestone = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(milestone.violations)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "New plan" }).click();
      await expect(page.getByRole("radio", { name: /Event/ })).toBeVisible();
      const plan = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(plan.violations)).toEqual([]);
      await page.keyboard.press("Escape");
      await openKnowledge(page, "Decisions");
      await page.getByRole("button", { name: "Record decision", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Record decision" })).toBeVisible();
      const decision = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(decision.violations)).toEqual([]);
      await page.keyboard.press("Escape");
      await openKnowledge(page, "Notes");
      await page.getByRole("button", { name: "Edit Search design" }).click();
      await expect(page.getByRole("dialog", { name: "Edit note" })).toBeVisible();
      const note = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(note.violations)).toEqual([]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", { name: "Search" });
      await palette.getByRole("combobox", { name: "Search" }).fill("search ranks");
      await palette.getByRole("button", { name: "Ask: search ranks" }).click();
      await expect(palette.getByRole("region", { name: "Answer" })).toContainText("Uses FTS5");
      const answer = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(answer.violations)).toEqual([]);
      await page.keyboard.press("Escape");
      await openKnowledge(page, "File cards");
      await page.getByRole("button", { name: "Edit docs/search.md" }).click();
      await expect(page.getByRole("dialog", { name: "Edit card" })).toBeVisible();
      const card = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(card.violations)).toEqual([]);
      await page.keyboard.press("Escape");
      // A phone has no keyboard, so its nav does not offer the sheet.
      if (await page.getByRole("button", { name: "Keyboard help" }).isVisible()) {
        await page.getByRole("button", { name: "Keyboard help" }).click();
        await expect(page.getByRole("dialog", { name: "Keyboard" })).toBeVisible();
        const keys = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(summary(keys.violations)).toEqual([]);
        await page.keyboard.press("Escape");
      }
      await page.getByRole("link", { name: "Team", exact: true }).click();
      await page
        .getByRole("button", { name: /^Edit / })
        .first()
        .click();
      await expect(page.getByRole("dialog", { name: "Edit person" })).toBeVisible();
      const person = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      expect(summary(person.violations)).toEqual([]);
    });
  });
}

function navName(path: string): string {
  const name = path.slice(1).replaceAll("-", " ");
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
