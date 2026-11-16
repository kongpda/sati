import { expect, test } from "@playwright/test";
import { startUi, type Ui } from "./server.js";
import { watch } from "./watch.js";

let ui: Ui;
test.beforeAll(async () => {
  ui = await startUi();
});
test.afterAll(async () => {
  await ui?.stop();
});

// Why: a phone shows one column, picked on load from the ones with tasks. The pick was made
// again on every live update, so an agent claiming a task moved the person to another column
// while they were reading this one.
test("a phone keeps its column when an agent's change lands", async ({ page }) => {
  const problems = await watch(page);
  await page.setViewportSize({ width: 375, height: 760 });
  const waiting = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Paint the fence" });
  await page.goto(ui.signIn);
  const choice = page.getByLabel("Status", { exact: true });
  await expect(page.getByRole("button", { name: "Paint the fence", exact: true })).toBeVisible();
  const opened = await choice.inputValue();
  expect(opened).not.toBe("in_progress");

  // An agent starts work: Working on it now has a task, and would win a fresh pick.
  ui.sati("task", "claim", waiting.id);
  await expect(page.getByRole("button", { name: "Paint the fence", exact: true })).toHaveCount(0);
  await expect(choice).toHaveValue(opened);
  expect(await problems()).toEqual([]);
});
