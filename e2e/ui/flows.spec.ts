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

const column = (page: import("@playwright/test").Page, name: string) =>
  page.getByRole("region", { name, exact: true });

// PLAN Phase 4: the board is reachable only through the token `sati ui` prints.
test("signs in with the printed token and refuses anything else", async ({ page, request }) => {
  expect((await request.get(`${ui.origin}/session?token=wrong`)).status()).toBe(401);
  expect((await request.get(`${ui.origin}/api/snapshot`)).status()).toBe(401);
  await page.goto(ui.signIn);
  await expect(page).toHaveURL(`${ui.origin}/`);
  await expect(page.getByRole("link", { name: "Board" })).toHaveAttribute("aria-current", "page");
});

test("creates, edits, filters and bulk-moves tasks", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  await expect(page.getByText("No tasks yet.")).toBeVisible();

  // `c` asks for a title and creates the task.
  page.once("dialog", (d) => void d.accept("Write the release notes"));
  await page.keyboard.press("c");
  const card = page.getByRole("button", { name: "Write the release notes" });
  await expect(card).toBeVisible();

  // The sheet saves an edit to title, body and status.
  await card.click();
  const sheet = page.getByRole("dialog", { name: "Write the release notes" });
  await sheet.getByLabel("Title").fill("Write release notes for 1.0");
  await sheet.getByLabel("Body").fill("Cover the `sati ui` board.");
  await sheet.getByLabel("Status").selectOption("in_progress");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(
    column(page, "In progress").getByRole("button", { name: "Write release notes for 1.0" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("code")).toHaveText("sati ui");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await ui.api("POST", "/api/tasks", { title: "Fix the flaky import test" });
  await ui.api("POST", "/api/tasks", { title: "Audit dependencies" });
  await page.reload();

  // The filter narrows the board by title.
  await page.getByLabel("Filter tasks").fill("flaky");
  await expect(page.getByRole("button", { name: "Fix the flaky import test" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audit dependencies" })).toHaveCount(0);
  // A filter that hides every task says so, instead of showing a blank board.
  await page.getByLabel("Filter tasks").fill("no task has this title");
  await expect(page.getByText("No tasks match the filter.")).toBeVisible();
  await page.getByLabel("Filter tasks").fill("");

  const pick = async (title: string) => {
    const box = page.locator(".card", { has: page.getByRole("button", { name: title }) });
    await box.getByRole("button", { name: "select" }).click();
  };
  const titles = ["Fix the flaky import test", "Audit dependencies"];
  const statuses = async () =>
    (await ui.api<{ tasks: { title: string; status: string }[] }>("GET", "/api/snapshot")).tasks
      .filter((t) => titles.includes(t.title))
      .map((t) => t.status);

  // A refused move rolls back every card and says why. Two moves fail at once, so a
  // whole-board rollback from one would bring back the other's refused state.
  for (const title of titles) await pick(title);
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByLabel("Move selected").selectOption("review");
  await expect(page.locator(".toast[role=status]")).toContainText(
    "cannot move from todo to review",
  );
  const todo = column(page, "Todo");
  for (const title of titles) await expect(todo.getByRole("button", { name: title })).toBeVisible();
  await expect(column(page, "Review").locator(".card")).toHaveCount(0);
  expect(await statuses()).toEqual(["todo", "todo"]);

  // An allowed bulk move lands on the server too.
  for (const title of titles) await pick(title);
  await page.getByLabel("Move selected").selectOption("in_progress");
  const doing = column(page, "In progress");
  for (const title of titles)
    await expect(doing.getByRole("button", { name: title })).toBeVisible();
  await expect.poll(statuses).toEqual(["in_progress", "in_progress"]);

  // Bulk move never offers Done: completion must go through `sati task complete`.
  await pick(titles[0] ?? "");
  await expect(page.getByLabel("Move selected").locator("option", { hasText: "Done" })).toHaveCount(
    0,
  );

  expect(await problems()).toEqual([]);
});

test("searches from the Ctrl+K palette and opens the hit", async ({ page }) => {
  await ui.api("POST", "/api/tasks", { title: "Rotate the signing key" });
  await page.goto(ui.signIn);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  const input = palette.getByRole("textbox", { name: "Search" });
  await expect(input).toBeFocused();
  await input.fill("signing");
  await input.press("Enter");
  await palette.getByRole("button", { name: /Rotate the signing key/u }).click();
  await expect(page.getByRole("dialog", { name: "Rotate the signing key" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("task")).toMatch(/^tsk_/u);
});

// PLAN Phase 4: Mermaid blocks render as diagrams under the strict CSP, and a bad one says why.
test("renders Mermaid in notes without CSP violations", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Notes" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Notes" })).toBeVisible();
  await page.getByLabel("Note title").fill("Sync flow");
  await page
    .getByLabel("Note body")
    .fill("How a write lands:\n\n```mermaid\nflowchart LR\n  A[write] --> B[export]\n```");
  await page.getByRole("button", { name: "Save note" }).click();
  const diagram = page.locator(".mermaid[data-ready=true]");
  await expect(diagram).toBeVisible();
  await expect(diagram.locator("svg")).toHaveCount(1);
  await expect(diagram).toContainText("export");

  await page.getByLabel("Note title").fill("Broken diagram");
  await page.getByLabel("Note body").fill("```mermaid\nflowchart LR\n  A -->\n```");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Diagram error" })).toBeVisible();

  expect(await problems()).toEqual([]);
});

test("every page loads and marks itself current", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  for (const name of ["Agents", "Roadmap", "Features", "Notes", "Decisions", "Activity", "Board"]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    if (name !== "Board") {
      await expect(page.getByRole("heading", { level: 1, name, exact: true })).toBeVisible();
      // PLAN: UX. The task filters only narrow the board, so other pages must not offer them.
      await expect(page.getByLabel("Filter tasks")).toHaveCount(0);
    } else {
      await expect(page.getByLabel("Filter tasks")).toBeVisible();
    }
  }
  await page.goBack();
  await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(await problems()).toEqual([]);
});
