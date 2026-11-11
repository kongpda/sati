import { expect, type Page, test } from "@playwright/test";
import { startUi, type Ui } from "./server.js";
import { watch } from "./watch.js";

// The board must not offer an action and then fail it: a person cannot tell a rule from a bug.
// Each test names a refusal core gives and checks that the board knows it before the click.

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const cardOf = (page: Page, title: string) =>
  page.getByRole("button", { name: title, exact: true });

/** Every task save the page sends, so a test can show that a refused action sent none. */
function patches(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && /\/api\/tasks\//u.test(r.url())) sent.push(r.url());
  });
  return sent;
}

/** Picks the card up by its handle with the mouse and holds it over the column. */
async function dragOver(page: Page, title: string, to: string): Promise<void> {
  // The copy from an earlier drop is still settling into place: it would take the click.
  await expect(page.locator(".card.dragging")).toHaveCount(0);
  const from = await page.getByRole("button", { name: `Move ${title}`, exact: true }).boundingBox();
  const target = await column(page, to).boundingBox();
  if (!from || !target) throw new Error(`Cannot drag ${title} to ${to}: not on the page.`);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 80, { steps: 12 });
  // The board scrolls sideways while a card is held near its edge, which moves the column from
  // under the pointer. Follow the column until it rests.
  const width = page.viewportSize()?.width ?? 1280;
  let at = target.x;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = await column(page, to).boundingBox();
    if (!now || Math.abs(now.x - at) < 1) break;
    at = now.x;
    await page.mouse.move(Math.min(now.x + now.width / 2, width - 4), now.y + 80, { steps: 4 });
  }
}

test.describe("a board run by a person", () => {
  let ui: Ui;
  test.beforeAll(async () => {
    ui = await startUi();
  });
  test.afterAll(async () => {
    await ui?.stop();
  });

  const create = (title: string) => ui.api<{ id: string }>("POST", "/api/tasks", { title });
  /** A task an agent finished, waiting for a person's approval. */
  async function inReview(title: string): Promise<string> {
    const { id } = await create(title);
    const agent = ui.as("codex@main#1", "agent");
    agent("task", "claim", id);
    agent("task", "complete", id, "--summary", `Did ${title}`, "--files", "notes/a.md");
    return id;
  }

  test("a card dropped where it cannot go stays, sends nothing and says why", async ({ page }) => {
    const problems = await watch(page);
    await create("Paint the sign");
    await page.goto(ui.signIn);
    const sent = patches(page);

    await dragOver(page, "Paint the sign", "Waiting for approval");
    // The column steps back while the card is held, before the drop.
    await expect(column(page, "Waiting for approval")).toHaveClass(/closed/u);
    await expect(column(page, "Working on it")).not.toHaveClass(/closed/u);
    await expect(column(page, "Waiting for approval").getByRole("heading")).toContainText(
      "cannot move here",
    );
    await page.mouse.up();
    await expect(page.getByRole("alert").locator(".toast")).toContainText(
      "finishes it with a summary",
    );
    await expect(
      column(page, "To do").getByRole("button", { name: "Paint the sign", exact: true }),
    ).toBeVisible();
    expect(sent).toEqual([]);

    // The same drag to a column that takes it lands.
    await dragOver(page, "Paint the sign", "Working on it");
    await page.mouse.up();
    await expect(
      column(page, "Working on it").getByRole("button", { name: "Paint the sign", exact: true }),
    ).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(await problems()).toEqual([]);
  });

  test("the task panel lists only the statuses the task can take, and keeps a title", async ({
    page,
  }) => {
    await create("Order the banner");
    await page.goto(ui.signIn);
    const sent = patches(page);
    await cardOf(page, "Order the banner").click();
    const sheet = page.getByRole("dialog", { name: "Order the banner" });
    await expect(sheet.getByLabel("Status").locator("option")).toHaveText([
      "Backlog",
      "To do",
      "Working on it",
      "Blocked",
      "Cancelled",
    ]);

    // Core refuses an empty title; the form holds the save instead of showing the refusal.
    await sheet.getByLabel("Title").fill("");
    await sheet.getByRole("button", { name: "Save" }).click();
    expect(
      await sheet.getByLabel("Title").evaluate((el: HTMLInputElement) => el.validity.valueMissing),
    ).toBe(true);
    expect(sent).toEqual([]);
  });

  test("sending work back from review asks for the reason, in the panel and from the board", async ({
    page,
  }) => {
    const problems = await watch(page);
    const first = await inReview("Proof the menu");
    const second = await inReview("Book the van");
    await page.goto(ui.signIn);

    await cardOf(page, "Proof the menu").click();
    const sheet = page.getByRole("dialog", { name: "Proof the menu" });
    await expect(sheet.getByLabel("What still needs doing")).toHaveCount(0);
    await sheet.getByLabel("Status").selectOption("todo");
    await expect(sheet.getByLabel("What still needs doing")).toHaveAttribute("required", "");
    await sheet.getByLabel("What still needs doing").fill("Add the prices.");
    await sheet.getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".toast")).toContainText("Saved");
    expect(ui.sati<{ status: string; reviewNote: string }>("task", "show", first)).toMatchObject({
      status: "todo",
      reviewNote: "Add the prices.",
    });
    await sheet.getByRole("button", { name: "Close" }).click();

    // The bulk menu asks the same question instead of sending a move core refuses.
    await page
      .locator(".card", { has: cardOf(page, "Book the van") })
      .getByRole("button", { name: "select" })
      .click();
    await page.getByLabel("Move selected").selectOption("todo");
    const dialog = page.getByRole("dialog", { name: "Send back Book the van" });
    await dialog.getByLabel("What still needs doing").fill("Ask for a bigger van.");
    await dialog.getByRole("button", { name: "Send back", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => ui.sati<{ status: string; reviewNote: string }>("task", "show", second))
      .toMatchObject({ status: "todo", reviewNote: "Ask for a bigger van." });
    expect(await problems()).toEqual([]);
  });

  test("a task an agent holds is locked until it is taken over, and a mixed move says why", async ({
    page,
  }) => {
    const problems = await watch(page);
    const held = await create("Wire the lights");
    await create("Sweep the hall");
    ui.as("codex@main#1", "agent")("task", "claim", held.id);
    await page.goto(ui.signIn);
    const sent = patches(page);

    // The card says who holds it; the panel explains and takes no edits.
    await expect(page.locator(".card", { has: cardOf(page, "Wire the lights") })).toContainText(
      "codex",
    );
    await cardOf(page, "Wire the lights").click();
    const sheet = page.getByRole("dialog", { name: "Wire the lights" });
    await expect(sheet.getByRole("region", { name: "Who is working on this" })).toContainText(
      "It cannot be changed here until",
    );
    await expect(sheet.getByLabel("Title")).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(sheet.getByLabel("New step")).toBeDisabled();
    await sheet.getByRole("button", { name: "Close" }).click();

    // One held task and one free task: the free one moves, the other says who holds it.
    for (const title of ["Wire the lights", "Sweep the hall"]) {
      await page
        .locator(".card", { has: cardOf(page, title) })
        .getByRole("button", { name: "select" })
        .click();
    }
    await page.getByLabel("Move selected").selectOption("backlog");
    await expect(page.getByRole("alert").locator(".toast")).toContainText(
      /1 of 2 tasks did not move\. .* is working on this task/u,
    );
    await expect(
      column(page, "Backlog").getByRole("button", { name: "Sweep the hall", exact: true }),
    ).toBeVisible();
    expect(sent).toHaveLength(1);

    // Taking it over unlocks the form.
    await cardOf(page, "Wire the lights").click();
    page.once("dialog", (d) => void d.accept());
    await sheet.getByRole("button", { name: "Take over" }).click();
    await expect(sheet.getByLabel("Title")).toBeEnabled();
    await expect(sheet.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(await problems()).toEqual([]);
  });

  test("a note cannot be given the tag kept for comments", async ({ page }) => {
    await page.goto(ui.signIn);
    await page.getByRole("link", { name: "Notes", exact: true }).click();
    await page.getByLabel("Note title").fill("Seating plan");
    await page.getByRole("button", { name: "Save note" }).click();
    await page.getByRole("button", { name: "Edit Seating plan" }).click();
    const edit = page.getByRole("dialog", { name: "Edit note" });
    await edit.getByLabel("Tags").fill("venue, comment");
    await edit.getByRole("button", { name: "Save note" }).click();
    expect(
      await edit.getByLabel("Tags").evaluate((el: HTMLInputElement) => el.validationMessage),
    ).toContain("kept for comments");
    await expect(edit).toBeVisible();
    await edit.getByLabel("Tags").fill("venue");
    await edit.getByRole("button", { name: "Save note" }).click();
    await expect(edit).toHaveCount(0);
  });
});

test.describe("a board started from an agent's terminal", () => {
  let ui: Ui;
  test.beforeAll(async () => {
    ui = await startUi({ agent: "codex@main#1" });
  });
  test.afterAll(async () => {
    await ui?.stop();
  });

  test("says it runs as an agent and does not offer what only a person may do", async ({
    page,
  }) => {
    const problems = await watch(page);
    const person = ui.as("sokha", "person");
    const mine = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Print the tickets" });
    person("task", "claim", mine.id);
    const done = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Fold the flyers" });
    ui.sati("task", "claim", done.id);
    ui.sati("task", "complete", done.id, "--summary", "Folded 200.", "--files", "notes/a.md");
    await page.goto(ui.signIn);
    const sent = patches(page);

    await expect(page.locator(".banner")).toContainText(/This board runs as .*, an agent\./u);

    // Approval is a person's: Done is not a choice for the task in review, here or on My work.
    await cardOf(page, "Fold the flyers").click();
    const review = page.getByRole("dialog", { name: "Fold the flyers" });
    await expect(review.getByLabel("Status").locator("option", { hasText: "Done" })).toHaveCount(0);
    await review.getByRole("button", { name: "Close" }).click();
    await dragOver(page, "Fold the flyers", "Done");
    await expect(column(page, "Done")).toHaveClass(/closed/u);
    await page.mouse.up();
    await expect(page.getByRole("alert").locator(".toast")).toContainText(
      "Only a person can approve work.",
    );
    await page.getByRole("alert").getByRole("button").click();
    expect(sent).toEqual([]);

    // A person's live claim: the panel says only a person can take it, with no buttons to fail.
    await cardOf(page, "Print the tickets").click();
    const sheet = page.getByRole("dialog", { name: "Print the tickets" });
    const claim = sheet.getByRole("region", { name: "Who is working on this" });
    await expect(claim).toContainText("Only a person can take it from them.");
    await expect(claim.getByRole("button")).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close" }).click();

    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit sokha" })).toBeDisabled();
    expect(await problems()).toEqual([]);
  });
});
