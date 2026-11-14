import { expect, test } from "@playwright/test";
import { startUi, type Ui } from "./server.js";

const CARDS = 2000;
let ui: Ui;

test.describe.configure({ timeout: 180_000 });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  ui = await startUi();
  const features = ["Search", "Sync", "Board", "CLI"].map(
    (title) => ui.sati<{ id: string }>("feature", "create", title).id,
  );
  // Eight writers at a time: the server still runs each write in its own transaction.
  let next = 0;
  const writer = async () => {
    while (next < CARDS) {
      const i = next++;
      await ui.api("POST", "/api/tasks", {
        title: `Card ${String(i).padStart(4, "0")}`,
        body: "Seeded for the board performance gate.",
        ...(i % 3 === 0 ? {} : { featureId: features[i % features.length] }),
      });
    }
  };
  await Promise.all(Array.from({ length: 8 }, writer));
});
test.afterAll(async () => {
  await ui?.stop();
});

// PLAN Phase 4 gate: the UI loads in under 1 s with 2,000 cards.
test("loads a 2,000-card board in under 1 s", async ({ page }) => {
  await page.goto(ui.signIn);
  await expect(page.getByRole("heading", { name: `To do ${CARDS}` })).toBeVisible();
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    await page.reload();
    await page.locator(".card").first().waitFor();
    times.push(Date.now() - start);
  }
  const median = [...times].sort((a, b) => a - b)[1] ?? Number.POSITIVE_INFINITY;
  test.info().annotations.push({ type: "load-ms", description: times.join(", ") });
  console.log(`load ms: ${times.join(", ")} (median ${median})`);
  expect(median).toBeLessThan(1000);
});

// PLAN Phase 4 gate: a 2,000-card board scrolls at 60 fps. Virtualisation keeps the DOM small,
// so scrolling costs the same at any board size.
test("scrolls a 2,000-card column at 60 fps", async ({ page }) => {
  await page.goto(ui.signIn);
  const todo = page.getByRole("region", { name: "To do", exact: true });
  await expect(todo.getByRole("heading", { name: `To do ${CARDS}` })).toBeVisible();
  expect(await page.locator(".card").count()).toBeLessThan(150);

  const frames = await todo.locator(".cards").evaluate(
    (el) =>
      new Promise<number[]>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const step = (now: number) => {
          deltas.push(now - last);
          last = now;
          el.scrollTop += 60;
          if (deltas.length < 240) requestAnimationFrame(step);
          else resolve(deltas.slice(1));
        };
        requestAnimationFrame(step);
      }),
  );
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const fps = 1000 / avg;
  const long = frames.filter((d) => d > 50).length;
  console.log(
    `scroll fps ${fps.toFixed(1)}, worst ${Math.max(...frames).toFixed(1)} ms, long ${long}`,
  );
  // The test scrolled deep into the column, so later cards were rendered on the way.
  await expect(todo.getByRole("button", { name: /^Card \d{4}$/u }).first()).toBeVisible();
  expect(fps).toBeGreaterThanOrEqual(55);
  expect(long).toBeLessThanOrEqual(2);
});

// Review 15.12: typing in the filter narrows a 2,000-card board within 100 ms (median of three,
// measured in the page from the input event to the frame that shows the result).
test("the filter narrows a 2,000-card board within 100 ms", async ({ page }) => {
  await page.goto(ui.signIn);
  await expect(page.getByRole("heading", { name: `To do ${CARDS}` })).toBeVisible();
  const times = await page.getByLabel("Filter tasks").evaluate(async (input: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const type = (text: string) => {
      set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const out: number[] = [];
    for (const text of ["Card 0042", "Card 1337", "Card 0777"]) {
      const start = performance.now();
      type(text);
      // Done when the board shows few cards: the matching one and nothing else of the 2,000.
      await new Promise<void>((resolve) => {
        const look = () =>
          document.querySelectorAll(".card").length <= 3 ? resolve() : requestAnimationFrame(look);
        look();
      });
      out.push(performance.now() - start);
      type("");
      await new Promise<void>((resolve) => {
        const look = () =>
          document.querySelectorAll(".card").length > 3 ? resolve() : requestAnimationFrame(look);
        look();
      });
    }
    return out;
  });
  const median = [...times].sort((a, b) => a - b)[1] ?? Number.POSITIVE_INFINITY;
  console.log(
    `filter ms: ${times.map((t) => t.toFixed(0)).join(", ")} (median ${median.toFixed(0)})`,
  );
  expect(median).toBeLessThan(100);
});

// Review 4.3: a long Knowledge list draws a page of rows, not all of them, and a link to a row
// past the page still opens it.
test("150 notes draw one page of rows, and a link to a later note opens it", async ({ page }) => {
  test.setTimeout(120_000);
  const ids: string[] = [];
  let next = 0;
  const writer = async () => {
    while (next < 150) {
      const i = next++;
      const note = await ui.api<{ id: string }>("POST", "/api/notes", {
        title: `Long list note ${String(i).padStart(3, "0")}`,
        body: "Seeded for the list budget.",
      });
      ids[i] = note.id;
    }
  };
  await Promise.all(Array.from({ length: 6 }, writer));
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Knowledge", exact: true }).click();
  await expect(page.locator("article.row").first()).toBeVisible();
  expect(await page.locator("article.row").count()).toBeLessThan(60);
  await page.getByRole("button", { name: /^Show more/u }).click();
  expect(await page.locator("article.row").count()).toBeGreaterThan(50);
  // Search opens a note by its id, wherever it sits in the list.
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search" }).fill("Long list note 000");
  await page
    .getByRole("option", { name: /Long list note 000/u })
    .first()
    .click();
  await expect(page.locator(`[id="${ids.at(0)}"]`)).toBeFocused();
});

// Review 4.2: an unchanged snapshot costs a header, and a changed one is never answered 304.
test("an unchanged snapshot answers 304", async ({ page }) => {
  await page.goto(ui.signIn);
  const first = await page.request.get(`${ui.origin}/api/snapshot`);
  const tag = first.headers().etag;
  expect(tag).toBeTruthy();
  const again = await page.request.get(`${ui.origin}/api/snapshot`, {
    headers: { "If-None-Match": tag ?? "" },
  });
  expect(again.status()).toBe(304);
  await ui.api("POST", "/api/tasks", { title: "Makes the snapshot change" });
  const changed = await page.request.get(`${ui.origin}/api/snapshot`, {
    headers: { "If-None-Match": tag ?? "" },
  });
  expect(changed.status()).toBe(200);
});
