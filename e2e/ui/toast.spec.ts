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

// Why: an Undo that leaves while the pointer or the focus is on it cannot be used, and the
// message sits at the end of the page, so reaching it by Tab took a walk through every card.
test("a message waits while it is held, and u undoes from the keyboard", async ({ page }) => {
  const problems = await watch(page);
  await page.clock.install();
  await page.goto(ui.signIn);
  const remove = async (title: string) => {
    const task = await ui.api<{ id: string }>("POST", "/api/tasks", { title });
    await page.goto(`${ui.origin}/?task=${task.id}`);
    await page.getByRole("button", { name: "Delete task" }).click();
    await expect(page.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  };
  const toast = page.locator('.toast-region[role="status"] .toast');

  // Held by the pointer: it stays past its ten seconds, and goes once the pointer leaves.
  await remove("Hang the lights");
  await toast.hover();
  await page.clock.runFor(15_000);
  await expect(toast).toContainText("Undo");
  await page.mouse.move(0, 0);
  await page.clock.runFor(11_000);
  await expect(toast).toHaveCount(0);

  // Held by the focus, the same way.
  await remove("Fold the chairs");
  await toast.getByRole("button", { name: "Undo" }).focus();
  await page.clock.runFor(15_000);
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Dismiss" }).click();

  // u takes the Undo the message offers, wherever the focus is.
  await remove("Stack the plates");
  await page.keyboard.press("u");
  await expect(page.getByRole("button", { name: "Stack the plates", exact: true })).toBeVisible();
  await expect(toast).toContainText("Restored Stack the plates.");
  await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);
  expect(await problems()).toEqual([]);
});
