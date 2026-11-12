import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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
/** The Log tab of the Changes page, where the old Activity page went. */
async function openLog(page: Page) {
  await page.getByRole("link", { name: "Changes", exact: true }).click();
  await page.getByRole("tab", { name: "Log", exact: true }).click();
}

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

  // The New task form creates a task with its details; a blank title cannot be sent.
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await expect(form.getByLabel("Title")).toBeFocused();
  await expect(form.getByRole("button", { name: "Create task" })).toBeDisabled();
  await form.getByLabel("Title").fill("Write the release notes");
  await form.getByLabel("Priority").selectOption("high");
  await form.getByLabel("Effort").selectOption("light");
  await form.getByLabel("Labels").fill("launch, docs, launch");
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form).toHaveCount(0);
  const card = page.getByRole("button", { name: "Write the release notes", exact: true });
  await expect(card).toBeVisible();
  // A light task is marked on its card, so a person sees what an agent may hand to a small model.
  await expect(page.locator(".card", { has: card }).getByText(/· Light/u)).toBeVisible();
  const created = ui
    .sati<{ title: string; priority: string; labels: string[] }[]>("task", "list")
    .find((t) => t.title === "Write the release notes");
  expect(created).toMatchObject({ priority: "high", effort: "light", labels: ["launch", "docs"] });

  // `c` opens the same form without typing the letter into it; Esc closes it unsaved. Focus went
  // back to the New task button, and shortcuts skip a focused button, so leave it first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  await expect(form.getByLabel("Title")).toHaveValue("");
  await form.getByLabel("Title").fill("Not saved");
  // Typed text is not thrown away silently: Esc asks first (review 6.1).
  page.once("dialog", (d) => void d.accept());
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Not saved", exact: true })).toHaveCount(0);

  // The sheet saves an edit to title, body and status.
  await card.click();
  const sheet = page.getByRole("dialog", { name: "Write the release notes" });
  await sheet.getByLabel("Title").fill("Write release notes for 1.0");
  await sheet.getByLabel("Body").fill("Cover the `sati ui` board.");
  await sheet.getByLabel("Status").selectOption("in_progress");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(
    column(page, "Working on it").getByRole("button", {
      name: "Write release notes for 1.0",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("code")).toHaveText("sati ui");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await ui.api("POST", "/api/tasks", { title: "Fix the flaky import test" });
  await ui.api("POST", "/api/tasks", { title: "Audit dependencies" });
  await page.reload();

  // The filter narrows the board by title.
  await page.getByLabel("Filter tasks").fill("flaky");
  await expect(
    page.getByRole("button", { name: "Fix the flaky import test", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Audit dependencies", exact: true })).toHaveCount(
    0,
  );
  // A filter that hides every task says so, instead of showing a blank board.
  await page.getByLabel("Filter tasks").fill("no task has this title");
  await expect(page.getByText("No tasks match the filter.")).toBeVisible();
  await page.getByLabel("Filter tasks").fill("");

  const pick = async (title: string) => {
    const box = page.locator(".card", {
      has: page.getByRole("button", { name: title, exact: true }),
    });
    await box.getByRole("button", { name: "select" }).click();
  };
  const titles = ["Fix the flaky import test", "Audit dependencies"];
  const statuses = async () =>
    (await ui.api<{ tasks: { title: string; status: string }[] }>("GET", "/api/snapshot")).tasks
      .filter((t) => titles.includes(t.title))
      .map((t) => t.status);

  // A refused move rolls back every card and says why. Two moves fail at once, so a
  // whole-board rollback from one would bring back the other's refused state. The board no
  // longer offers a move it knows core refuses, so the refusal here is one it cannot foresee.
  for (const title of titles) await pick(title);
  await expect(page.getByText("2 selected")).toBeVisible();
  await expect(
    page.getByLabel("Move selected").locator("option", { hasText: "Waiting for approval" }),
  ).toHaveCount(0);
  await page.route("**/api/tasks/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "CONFLICT", message: "The store is busy." } }),
        })
      : route.fallback(),
  );
  await page.getByLabel("Move selected").selectOption("blocked");
  // An error, so it stays until it is closed; the plain toast left after 6 seconds.
  await expect(page.getByRole("alert").locator(".toast")).toContainText(
    "2 of 2 tasks did not move.",
  );
  const todo = column(page, "To do");
  for (const title of titles)
    await expect(todo.getByRole("button", { name: title, exact: true })).toBeVisible();
  await expect(column(page, "Blocked").locator(".card")).toHaveCount(0);
  expect(await statuses()).toEqual(["todo", "todo"]);
  await page.unroute("**/api/tasks/*");

  // An allowed bulk move lands on the server too.
  // Refused tasks stay selected, so the next move applies to them without picking again.
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByLabel("Move selected").selectOption("in_progress");
  const doing = column(page, "Working on it");
  for (const title of titles)
    await expect(doing.getByRole("button", { name: title, exact: true })).toBeVisible();
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
  for (const name of [
    "My work",
    "Agents",
    "Roadmap",
    "Features",
    "Notes",
    "Memory",
    "Decisions",
    "Changes",
    "Settings",
    "Board",
  ]) {
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
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: people plan the roadmap and record decisions in the UI, without a terminal.
test("creates and edits a milestone, records and replaces a decision", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Roadmap", exact: true }).click();
  await page.getByRole("button", { name: "New milestone" }).click();
  const create = page.getByRole("dialog", { name: "New milestone" });
  await expect(create.getByLabel("Name")).toBeFocused();
  await expect(create.getByRole("button", { name: "Create milestone" })).toBeDisabled();
  await create.getByLabel("Name").fill("Launch event");
  await create.getByLabel("Goal").fill("Guests in the room by 7 pm.");
  await create.getByLabel("Target date").fill("2026-12-04");
  await create.getByRole("button", { name: "Create milestone" }).click();
  await expect(create).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 2, name: "Launch event" })).toBeVisible();

  // An edit made elsewhere after the dialog opened is refused, and the draft stays.
  await page.getByRole("button", { name: "Edit Launch event" }).click();
  const edit = page.getByRole("dialog", { name: "Edit milestone" });
  await expect(edit.getByLabel("Name")).toHaveValue("Launch event");
  const [made] = ui.sati<{ id: string }[]>("milestone", "list", "--json");
  ui.sati("milestone", "update", made?.id ?? "", "--goal", "Changed by an agent");
  await edit.getByLabel("Status").selectOption("active");
  await edit.getByRole("button", { name: "Save milestone" }).click();
  await expect(edit.getByRole("alert")).toBeVisible();
  await expect(edit.getByLabel("Status")).toHaveValue("active");
  await edit.getByRole("button", { name: "Cancel" }).click();
  // Live updates bring the agent's edit in; editing again starts from that version.
  await expect(page.getByText("Changed by an agent")).toBeVisible();

  await page.getByRole("button", { name: "Edit Launch event" }).click();
  await edit.getByLabel("Status").selectOption("active");
  await edit.getByRole("button", { name: "Save milestone" }).click();
  await expect(edit).toHaveCount(0);
  const [saved] = ui.sati<{ status: string; goal: string; targetDate: string }[]>(
    "milestone",
    "list",
    "--json",
  );
  expect(saved).toMatchObject({
    status: "active",
    goal: "Changed by an agent",
    targetDate: "2026-12-04",
  });

  await page.getByRole("link", { name: "Decisions", exact: true }).click();
  await page.getByRole("button", { name: "Record decision", exact: true }).click();
  const record = page.getByRole("dialog", { name: "Record decision" });
  await record.getByLabel("Title").fill("Hold the launch at the riverside venue");
  // Both the title and the decision text are required.
  await expect(record.getByRole("button", { name: "Record decision", exact: true })).toBeDisabled();
  await record.getByLabel("Decision", { exact: true }).fill("Book the riverside hall.");
  await record.getByLabel("Context").fill("The hotel was full.");
  await record.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(record).toHaveCount(0);

  await page
    .getByRole("button", { name: "Replace Hold the launch at the riverside venue" })
    .click();
  const replace = page.getByRole("dialog", { name: "Replace decision" });
  await replace.getByLabel("Title").fill("Hold the launch on the rooftop");
  await replace.getByLabel("Decision", { exact: true }).fill("The hall flooded; use the rooftop.");
  await replace.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(replace).toHaveCount(0);
  await expect(page.getByText("replaced by Hold the launch on the rooftop")).toBeVisible();
  const decisions = ui.sati<{ id: string; title: string; supersedes: string | null }[]>(
    "decision",
    "list",
    "--json",
  );
  const first = decisions.find((d) => d.title === "Hold the launch at the riverside venue");
  const second = decisions.find((d) => d.title === "Hold the launch on the rooftop");
  expect(second?.supersedes).toBe(first?.id);
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: notes are edited, tagged, pinned and deleted in the UI; deletes have Undo.
test("edits, pins, tags and deletes notes, and undoes deletes", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  for (const title of ["Venue options", "Catering"]) {
    await page.getByLabel("Note title").fill(title);
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
  }

  await page.getByRole("button", { name: "Edit Venue options" }).click();
  const edit = page.getByRole("dialog", { name: "Edit note" });
  await expect(edit.getByLabel("Title")).toHaveValue("Venue options");
  await edit.getByLabel("Body").fill("Riverside hall, rooftop.");
  await edit.getByLabel("Tags").fill("venue, launch, venue");
  await edit.getByLabel(/^Pin/).check();
  await edit.getByRole("button", { name: "Save note" }).click();
  await expect(edit).toHaveCount(0);
  // Pinned notes come first, although Catering is newer.
  await expect(page.locator("article h2").first()).toHaveText("PinnedVenue options");
  const notes = ui.sati<{ title: string; tags: string[]; pinned: boolean; body: string }[]>(
    "note",
    "list",
  );
  expect(notes.find((n) => n.title === "Venue options")).toMatchObject({
    tags: ["venue", "launch"],
    pinned: true,
    body: "Riverside hall, rooftop.",
  });

  // The tag filter narrows the list; All shows everything again.
  await page.getByRole("button", { name: "venue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Catering" })).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Unpin Venue options" }).click();
  await expect(page.getByRole("button", { name: "Pin Venue options" })).toBeVisible();

  await page.getByRole("button", { name: "Delete Catering" }).click();
  await expect(page.getByRole("status")).toContainText("Deleted Catering.");
  await expect(page.getByRole("heading", { level: 2, name: "Catering" })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Catering" })).toBeVisible();

  // A task is deleted from its panel and comes back with Undo.
  const task = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Order banners" });
  await page.goto(`${ui.origin}/?task=${task.id}`);
  await page.getByRole("button", { name: "Delete task" }).click();
  await expect(page.getByRole("dialog", { name: "Order banners" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Order banners", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: "Order banners", exact: true })).toBeVisible();
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: people and agents talk on a task, note or decision; agents read it in the brief.
test("comments on a task, a note and a decision, and deletes one with Undo", async ({ page }) => {
  const problems = await watch(page);
  const t = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Print the flyers" });
  ui.sati("comment", "add", t.id, "The printer opens at **9**.");
  await page.goto(ui.signIn);
  await page.goto(`${ui.origin}/?task=${t.id}`);
  const sheet = page.getByRole("dialog", { name: "Print the flyers" });
  const thread = sheet.getByRole("region", { name: /^Comments/u });
  await expect(thread.getByRole("heading", { name: "Comments · 1" })).toBeVisible();
  await expect(thread.locator("strong", { hasText: "9" })).toBeVisible();

  // Ctrl+Enter sends; the box empties and the comment shows under your name.
  const box = thread.getByLabel("Add a comment");
  await box.fill("Use the matte paper");
  await box.press("Control+Enter");
  await expect(thread.getByRole("heading", { name: "Comments · 2" })).toBeVisible();
  await expect(box).toHaveValue("");
  await expect(thread.locator("li").last()).toContainText("Use the matte paper");
  await thread
    .getByRole("button", { name: /^Delete your comment/u })
    .last()
    .click();
  await expect(page.locator(".toast")).toContainText("Deleted the comment.");
  await expect(thread.getByRole("heading", { name: "Comments · 1" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(thread.getByRole("heading", { name: "Comments · 2" })).toBeVisible();
  const said = ui.sati<{ body: string }[]>("comment", "list", t.id).map((c) => c.body);
  expect(said).toEqual(["The printer opens at **9**.", "Use the matte paper"]);
  await page.keyboard.press("Escape");

  // On list pages the thread is folded; comments are not listed as notes of their own.
  await ui.api("POST", "/api/notes", { title: "Supplier list" });
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^Comment on/u })).toHaveCount(0);
  const note = page.locator("article").filter({ hasText: "Supplier list" });
  await expect(note.getByLabel("Add a comment")).toBeHidden();
  await note.getByText("Comments", { exact: true }).click();
  await note.getByLabel("Add a comment").fill("Ask for two quotes");
  await note.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(note.getByText("Comments · 1")).toBeVisible();
  await expect(note.getByLabel("Add a comment")).toBeVisible();

  await ui.api("POST", "/api/decisions", {
    title: "Print locally",
    decision: "Use the shop nearby.",
  });
  await page.getByRole("link", { name: "Decisions", exact: true }).click();
  const dec = page.locator("article").filter({ hasText: "Print locally" });
  await dec.getByText("Comments", { exact: true }).click();
  await dec.getByLabel("Add a comment").fill("Agreed");
  await dec.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(dec.getByText("Comments · 1")).toBeVisible();

  await openLog(page);
  await expect(
    page.locator("article").filter({ hasText: "commented on Print locally" }).first(),
  ).toBeVisible();
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: a person plans a task with a due date, who should do it, and its steps.
test("plans a task with a due date, an assignee and a checklist", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await form.getByLabel("Title").fill("Send the invitations");
  await form.getByLabel("Due date").fill("2026-12-01");
  await form.getByRole("checkbox", { name: /\(you\)/u }).check();
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form).toHaveCount(0);
  const card = page.locator(".card").filter({ hasText: "Send the invitations" });
  await expect(card.locator("time[datetime='2026-12-01']")).toContainText("due");

  await card.getByRole("button", { name: "Send the invitations", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Send the invitations" });
  await expect(sheet.getByLabel("Due date")).toHaveValue("2026-12-01");
  for (const step of ["Guest list", "Print cards"]) {
    await sheet.getByLabel("New step").fill(step);
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await expect(sheet.getByRole("checkbox", { name: step })).toBeVisible();
  }
  // A tick saves at once; it must not throw away text typed in the form but not yet saved.
  await sheet.getByLabel("Body").fill("Ask the printer for a proof.");
  await sheet.getByRole("checkbox", { name: "Guest list" }).check();
  await expect(sheet.getByRole("heading", { name: "Checklist · 1/2" })).toBeVisible();
  await expect(sheet.getByLabel("Body")).toHaveValue("Ask the printer for a proof.");
  await expect(card).toContainText("1/2 steps");

  // Clearing the due date in the panel saves null, and the task drops out of the due filter.
  await sheet.getByLabel("Due date").fill("");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.locator("time[datetime='2026-12-01']")).toHaveCount(0);
  const [task] = ui.sati<
    {
      dueDate: string | null;
      assigneeIds: string[];
      checklist: { text: string; done: boolean }[];
    }[]
  >("task", "list", "--assignee", "me", "--full");
  expect(task).toMatchObject({
    dueDate: null,
    checklist: [
      { text: "Guest list", done: true },
      { text: "Print cards", done: false },
    ],
  });
  expect(ui.sati<unknown[]>("task", "list", "--due-by", "2026-12-31")).toEqual([]);
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: "My work" lists what waits for me: approvals, my tasks, then what is due.
test("My work lists approvals, my tasks and this week's, and approves or sends back", async ({
  page,
}) => {
  const problems = await watch(page);
  const { you } = await ui.api<{ you: string }>("GET", "/api/snapshot");
  ui.sati("settings", "--review", "all");
  const reviewed: string[] = [];
  for (const title of ["Proof the flyer", "Check the guest list"]) {
    const t = await ui.api<{ id: string }>("POST", "/api/tasks", { title });
    ui.sati("task", "claim", t.id);
    ui.sati("task", "complete", t.id, "--summary", `Did ${title}`, "--files", "notes/a.md");
    reviewed.push(t.id);
  }
  ui.sati("settings", "--review", "agents");
  await ui.api("POST", "/api/tasks", { title: "Call the caterer", assigneeIds: [you] });
  const soon = new Date();
  const day = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  await ui.api("POST", "/api/tasks", { title: "Pay the deposit", dueDate: day });
  await ui.api("POST", "/api/tasks", { title: "Plan next year", dueDate: "2099-01-01" });

  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "My work", exact: true }).click();
  const approval = page.getByRole("region", { name: "Waiting for your approval" });
  const assigned = page.getByRole("region", { name: "Assigned to you" });
  const due = page.getByRole("region", { name: /^Due by / });
  await expect(approval).toContainText("Did Proof the flyer");
  await expect(assigned).toContainText("Call the caterer");
  await expect(due).toContainText("Pay the deposit");
  await expect(page.getByText("Plan next year")).toHaveCount(0);

  await approval.getByRole("button", { name: "Approve: Proof the flyer" }).click();
  await expect(page.getByRole("status")).toContainText("Approved Proof the flyer.");
  await expect(approval).not.toContainText("Proof the flyer");

  // Sending back needs a reason; the next claimer sees it.
  await approval.getByRole("button", { name: "Send back Check the guest list" }).click();
  await approval.getByLabel("Why Check the guest list needs more work").fill("Add the press list.");
  await approval.getByRole("button", { name: "Send back", exact: true }).click();
  // The toast names the column as the board does (review 6.2).
  await expect(page.getByRole("status")).toContainText("Sent Check the guest list back to To do.");
  await expect(approval).toContainText("Nothing to approve.");
  const back = ui.sati<{ status: string; reviewNote: string }>("task", "show", reviewed[1] ?? "");
  expect(back).toMatchObject({ status: "todo", reviewNote: "Add the press list." });
  expect(ui.sati<{ status: string }>("task", "show", reviewed[0] ?? "").status).toBe("done");

  // A title opens the task panel over the page.
  await assigned.getByRole("button", { name: "Call the caterer" }).click();
  await expect(page.getByRole("dialog", { name: "Call the caterer" })).toBeVisible();
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: a person picks how they are shown; the board uses it everywhere.
test("sets a person's display name, initials and colour, shown on the board", async ({ page }) => {
  const problems = await watch(page);
  const { you } = await ui.api<{ you: string }>("GET", "/api/snapshot");
  await ui.api("POST", "/api/tasks", { title: "Brief the photographer", assigneeIds: [you] });
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Edit playwright" }).click();
  const form = page.getByRole("dialog", { name: "Edit person" });
  await form.getByLabel("Display name").fill("Sokha Chan");
  await expect(form.getByLabel("Initials")).toHaveAttribute("placeholder", "SC");
  await form.getByLabel("Initials").fill("SK");
  await form.getByRole("radio", { name: "Plum" }).check();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 3, name: "Sokha Chan (you)" })).toBeVisible();

  // The card's avatar and the activity log use the new name.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  const avatar = page
    .locator(".card")
    .filter({ hasText: "Brief the photographer" })
    .getByRole("img", { name: "Sokha Chan" });
  await expect(avatar).toHaveText("SK");
  await expect(avatar).toHaveClass(/c-plum/u);
  await openLog(page);
  await expect(page.locator("article strong").first()).toHaveText("Sokha Chan");

  // A blank field goes back to the default.
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Edit Sokha Chan" }).click();
  await form.getByLabel("Initials").fill("");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect(form).toHaveCount(0);
  const actor = (
    await ui.api<{ actors: { id: string; initials?: string; color?: string }[] }>(
      "GET",
      "/api/snapshot",
    )
  ).actors.find((a) => a.id === you);
  expect(actor).toMatchObject({ color: "plum" });
  expect(actor?.initials).toBeUndefined();
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: the board speaks plainly; the CLI and MCP keep their terms.
test("uses plain words for statuses, activity and times", async ({ page }) => {
  const problems = await watch(page);
  const t = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Write the toast" });
  ui.sati("task", "claim", t.id);
  await page.goto(`${ui.signIn}`);
  await page.goto(`${ui.origin}/?task=${t.id}`);
  const sheet = page.getByRole("dialog", { name: "Write the toast" });
  // "You are working on this until 2:32 PM", not a lease timestamp.
  const claim = sheet.getByRole("region", { name: "Who is working on this" });
  await expect(claim).toContainText("You are working on this until");
  await expect(claim).not.toContainText("Z.");
  await expect(claim.locator("time")).not.toHaveAttribute("title", /T\d\d:/u);
  await expect(sheet.getByLabel("Status").locator("option:checked")).toHaveText("Working on it");
  await page.keyboard.press("Escape");
  await expect(column(page, "Working on it")).toContainText("Write the toast");

  await openLog(page);
  const row = page.locator("article").filter({ hasText: "Write the toast" }).first();
  await expect(row).toContainText("started working on the task");
  await expect(page.locator("article").filter({ hasText: "added the task" }).first()).toBeVisible();
  // The CLI still says in_progress.
  expect(ui.sati<{ status: string }>("task", "show", t.id).status).toBe("in_progress");
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7a: a general project (an event, a campaign) has no features or file reservations.
test("a general project hides features and the Agents page, and switches back", async ({
  page,
}) => {
  const problems = await watch(page);
  const f = ui.sati<{ id: string }>("feature", "create", "Ticketing", "--paths", "src/tickets/**");
  await ui.api("POST", "/api/tasks", { title: "Book the venue", featureId: f.id });
  await page.goto(ui.signIn);
  const nav = page.getByRole("navigation");
  await expect(nav.getByRole("link", { name: "Features", exact: true })).toBeVisible();

  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: /General project/u }).check();
  await expect(page.getByRole("status")).toContainText("This is now a general project.");
  // The choices stay usable while saving, so the chosen radio keeps focus (review 6.3).
  await expect(page.getByRole("radio", { name: /General project/u })).toBeFocused();
  await expect(nav.getByRole("link", { name: "Features", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Agents", exact: true })).toHaveCount(0);
  expect(ui.sati<{ kind: string }>("settings").kind).toBe("general");

  // The board drops the feature filter and the feature on the card; the task is still there.
  await nav.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByLabel("Feature", { exact: true })).toHaveCount(0);
  const card = page.locator(".card").filter({ hasText: "Book the venue" });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText("Ticketing");
  await page.goto(`${ui.origin}/features`);
  await expect(page.getByText("A general project has no features")).toBeVisible();

  // With no features, a task joins a plan directly, and the Roadmap counts it.
  await ui.api("POST", "/api/milestones", { title: "Spring launch" });
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await form.getByLabel("Title").fill("Print the programme");
  await form.getByLabel("Plan").selectOption({ label: "Spring launch" });
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("link", { name: "Roadmap", exact: true }).click();
  await expect(page.locator("article").filter({ hasText: "Spring launch" })).toContainText(
    "0/1 tasks done",
  );

  // Search does not offer the feature: its page is hidden here, so the hit opened a dead end.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  await palette.getByRole("textbox", { name: "Search" }).fill("Ticketing");
  await palette.getByRole("textbox", { name: "Search" }).press("Enter");
  await expect(palette.getByRole("status")).toHaveText("No results");
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: /Software project/u }).check();
  await expect(nav.getByRole("link", { name: "Features", exact: true })).toBeVisible();
  expect(ui.sati<{ kind: string }>("settings").kind).toBe("code");
  expect(await problems()).toEqual([]);
});

// PLAN Phase 5b: j/k walked the snapshot, not the board, and left `?task=` behind. It must step
// through the cards as shown (column by column, lanes by feature, filters and the phone's column
// choice) and keep the URL in step, as a click does.
test("j and k step through the cards in board order and keep ?task= in step", async ({ page }) => {
  const problems = await watch(page);
  // Backlog starts folded (review 1.3); this test is about its cards, so open it.
  await page.addInitScript(() =>
    localStorage.setItem("sati.ui.v1", JSON.stringify({ collapsedColumns: [] })),
  );
  const alpha = ui.sati<{ id: string }>("feature", "create", "Alpha", "--paths", "src/alpha/**");
  const beta = ui.sati<{ id: string }>("feature", "create", "Beta", "--paths", "src/beta/**");
  const make = (title: string, status: string, featureId?: string) =>
    ui.api<{ id: string; title: string }>("POST", "/api/tasks", { title, status, featureId });
  // Created in an order unlike the board's, which sorts by column, then by feature lane.
  const todoPlain = await make("Kestrel todo plain", "todo");
  const backlogBeta = await make("Kestrel backlog Beta", "backlog", beta.id);
  const todoAlpha = await make("Kestrel todo Alpha", "todo", alpha.id);
  const backlogAlpha = await make("Kestrel backlog Alpha", "backlog", alpha.id);
  await page.goto(ui.signIn);
  await page.getByLabel("Filter tasks").fill("Kestrel");
  // j does nothing until the board has loaded and the filter has applied.
  await expect(page.locator(".card")).toHaveCount(4);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const at = async (key: string, task: { id: string; title: string } | null) => {
    await page.keyboard.press(key);
    if (task === null) {
      await expect(page).toHaveURL(`${ui.origin}/`);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      return;
    }
    await expect(page).toHaveURL(`${ui.origin}/?task=${task.id}`);
    await expect(page.getByRole("dialog", { name: task.title })).toBeVisible();
  };
  // Backlog (Alpha lane, then Beta), then To do (Alpha, then No feature); then it wraps.
  await at("j", backlogAlpha);
  await at("j", backlogBeta);
  await at("j", todoAlpha);
  await at("j", todoPlain);
  await at("j", backlogAlpha);
  await at("k", todoPlain);
  // The URL opens the same panel, and Back returns to the card before.
  await page.goBack();
  await expect(page).toHaveURL(`${ui.origin}/?task=${backlogAlpha.id}`);
  await page.goForward();
  await expect(page.getByRole("dialog", { name: "Kestrel todo plain" })).toBeVisible();
  await at("Escape", null);
  // After closing, j carries on from the card that was open.
  await at("j", backlogAlpha);
  await at("Escape", null);

  // The feature filter narrows the walk too.
  await page.getByLabel("Feature", { exact: true }).selectOption({ label: "Beta" });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await at("j", backlogBeta);
  await at("j", backlogBeta);
  await at("Escape", null);
  await page.getByLabel("Feature", { exact: true }).selectOption("");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // On a phone (the switch follows a resize, not just the first load) only the chosen column.
  const choice = page.getByLabel("Status", { exact: true });
  await page.setViewportSize({ width: 375, height: 760 });
  // A phone opens on one column (the first of Working on it, Waiting, To do, Backlog with tasks).
  await expect(choice).not.toHaveValue("all");
  await choice.selectOption("todo");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await at("j", todoAlpha);
  await at("j", todoPlain);
  await at("j", todoAlpha);
  await at("Escape", null);
  // "All columns" snaps a column at a time instead of stopping midway.
  await choice.selectOption("all");
  await expect(page.locator(".board")).toHaveCSS("scroll-snap-type", "x mandatory");
  await expect(column(page, "To do")).toHaveCSS("scroll-snap-align", "start");
  // The nav hints at the pages off its right edge.
  const fade = await page
    .getByRole("navigation")
    .evaluate((nav) => getComputedStyle(nav, "::after").backgroundImage);
  expect(fade).toContain("linear-gradient");
  // Back to a wide screen: every column again, and k steps from To do back into Backlog.
  await choice.selectOption("todo");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(choice).toHaveValue("all");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await at("k", backlogBeta);
  await at("Escape", null);
  expect(await problems()).toEqual([]);
});

// PLAN Phase 5d: on a wide screen the board beside the task panel stays usable, so a click on
// another card switches tasks. Unsaved edits are never dropped without asking. A phone keeps the
// panel modal, because it covers the board.
test("on a wide screen the task panel sits beside a usable board and guards unsaved edits", async ({
  page,
}) => {
  const problems = await watch(page);
  const make = (title: string) => ui.api<{ id: string }>("POST", "/api/tasks", { title });
  const first = await make("Heron first");
  const second = await make("Heron second");
  await page.goto(`${ui.signIn}`);
  await page.getByLabel("Filter tasks").fill("Heron");
  await expect(page.locator(".card")).toHaveCount(2);
  const card = (title: string) => page.getByRole("button", { name: title, exact: true });

  await card("Heron first").click();
  const panel = page.getByRole("dialog", { name: "Heron first" });
  await expect(panel).toHaveAttribute("aria-modal", "false");
  // Clean panel: another card switches at once.
  await card("Heron second").click();
  await expect(page).toHaveURL(`${ui.origin}/?task=${second.id}`);
  const other = page.getByRole("dialog", { name: "Heron second" });

  // Unsaved edits: cancelling the prompt keeps the panel and the typing.
  await other.getByLabel("Body").fill("Half-written thought");
  const asked: string[] = [];
  page.once("dialog", (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await card("Heron first").click();
  await expect.poll(() => asked).toEqual(["Discard your unsaved changes to this task?"]);
  await expect(page).toHaveURL(`${ui.origin}/?task=${second.id}`);
  await expect(other.getByLabel("Body")).toHaveValue("Half-written thought");
  // Accepting it switches, and nothing was saved.
  page.once("dialog", (d) => void d.accept());
  await card("Heron first").click();
  await expect(page).toHaveURL(`${ui.origin}/?task=${first.id}`);
  expect(ui.sati<{ body: string }>("task", "show", second.id).body).toBe("");

  // Clicking the open card again keeps it dirty, and Back asks too: declining keeps the panel.
  const firstPanel = page.getByRole("dialog", { name: "Heron first" });
  await firstPanel.getByLabel("Body").fill("Second thought");
  await card("Heron first").click();
  const back: string[] = [];
  page.once("dialog", (d) => {
    back.push(d.message());
    void d.dismiss();
  });
  await page.goBack();
  await expect.poll(() => back).toEqual(["Discard your unsaved changes to this task?"]);
  await expect(page).toHaveURL(`${ui.origin}/?task=${first.id}`);
  await expect(firstPanel.getByLabel("Body")).toHaveValue("Second thought");

  // A phone: the panel covers the board, so it is modal and the board takes no clicks.
  await page.setViewportSize({ width: 390, height: 760 });
  await expect(page.getByRole("dialog", { name: "Heron first" })).toHaveAttribute(
    "aria-modal",
    "true",
  );
  await expect(page.locator("main.main")).toHaveAttribute("inert", "");
  await page.setViewportSize({ width: 1280, height: 720 });
  page.once("dialog", (d) => void d.accept());
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await problems()).toEqual([]);
});

// PLAN Phase 5b: a feature's paths field must keep unsaved typing through refreshes caused by
// other records, and still show a change made elsewhere once nothing is typed in it.
test("the Features paths field keeps typed text across a refresh and shows changes made elsewhere", async ({
  page,
}) => {
  const problems = await watch(page);
  const harbour = ui.sati<{ id: string; version: number }>(
    "feature",
    "create",
    "Harbour",
    "--paths",
    "src/harbour/**",
  );
  const light = ui.sati<{ id: string; version: number }>(
    "feature",
    "create",
    "Lighthouse",
    "--paths",
    "src/light/**",
  );
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Features", exact: true }).click();
  const typed = page.getByLabel("Paths for Harbour, one per line");
  const other = page.getByLabel("Paths for Lighthouse, one per line");
  await typed.fill("src/harbour/**\nsrc/docks/**");

  // Writes elsewhere refresh the page: one to another feature, one to a task.
  await ui.api("PATCH", `/api/features/${light.id}`, {
    paths: ["src/lamp/**"],
    expectedVersion: light.version,
  });
  await ui.api("POST", "/api/tasks", { title: "Paint the lighthouse" });
  // The untouched field shows the new paths (before, it kept showing the old ones).
  await expect(other).toHaveValue("src/lamp/**");
  await expect(typed).toHaveValue("src/harbour/**\nsrc/docks/**");
  await expect(typed).toBeFocused();

  const pathsOf = (id: string) =>
    ui
      .sati<{ id: string; paths: string[]; version: number }[]>("feature", "list")
      .find((f) => f.id === id);
  await page
    .locator("article")
    .filter({ hasText: "Harbour" })
    .getByRole("button", { name: "Save paths" })
    .click();
  await expect.poll(() => pathsOf(harbour.id)?.paths).toEqual(["src/harbour/**", "src/docks/**"]);

  // Once saved, a change made elsewhere shows in the field.
  const saved = pathsOf(harbour.id);
  await ui.api("PATCH", `/api/features/${harbour.id}`, {
    paths: ["src/quay/**"],
    expectedVersion: saved?.version,
  });
  await expect(typed).toHaveValue("src/quay/**");
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7b: a person reads what changed and copies the changelog without a terminal.
test("Changes shows done work by day, filters it and copies the changelog", async ({
  page,
  context,
}) => {
  const problems = await watch(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ui.origin });
  ui.sati("settings", "--review", "none");
  const plan = ui.sati<{ id: string }>("milestone", "create", "Spring fair");
  const done = (title: string, note: string, extra: string[] = []) => {
    const t = ui.sati<{ id: string }>("task", "create", title, ...extra);
    ui.sati("task", "claim", t.id);
    ui.sati(
      "task",
      "complete",
      t.id,
      "--summary",
      `Did ${title}`,
      "--release-note",
      note,
      "--files",
      "fair/plan.md",
    );
    return t.id;
  };
  done("Print the flyers", "Flyers are at the front desk", [
    "--milestone",
    plan.id,
    "--labels",
    "feature",
  ]);
  done("Fix the ticket link", "The ticket link works again", ["--labels", "bug"]);
  done("Rotate keys", "Keys rotated", ["--labels", "internal"]);

  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Changes", exact: true }).click();
  const today = page.getByRole("region", { name: "Today" });
  await expect(today.getByText("Flyers are at the front desk")).toBeVisible();
  await expect(today.getByText("The ticket link works again")).toBeVisible();

  // The plan filter keeps only that plan's work, and the changelog follows it.
  await page.getByLabel("Plan").selectOption({ label: "Spring fair" });
  await expect(today.getByText("The ticket link works again")).toHaveCount(0);
  await page.getByRole("button", { name: "Copy changelog" }).click();
  await expect(page.getByRole("status")).toContainText("Copied the changelog.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe("## Spring fair\n\n### Added\n- Flyers are at the front desk\n");

  // Without the filter the changelog has both, and never the internal task.
  await page.getByLabel("Plan").selectOption({ label: "All plans" });
  await expect(today.getByText("The ticket link works again")).toBeVisible();
  await page.getByRole("button", { name: "Copy changelog" }).click();
  const all = await page.evaluate(() => navigator.clipboard.readText());
  expect(all).toContain("### Fixed\n- The ticket link works again");
  expect(all).not.toContain("Keys rotated");

  // A done task opens in the task panel.
  await today.getByRole("button", { name: "Fix the ticket link" }).click();
  await expect(page.getByRole("dialog", { name: "Fix the ticket link" })).toBeVisible();
  ui.sati("settings", "--review", "agents");
  expect(await problems()).toEqual([]);
});

// PLAN Phase 7c: a person starts an event plan from a template on the board, and an agent's
// `sati template apply` makes the same plan.
test("New plan creates a milestone and its staged tasks from a template", async ({ page }) => {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Roadmap", exact: true }).click();
  await page.getByRole("button", { name: "New plan" }).click();
  const dialog = page.getByRole("dialog", { name: "New plan" });
  await dialog.getByRole("radio", { name: /Event/ }).check();
  await expect(dialog.getByText("Plan: 3 tasks, 8 weeks before")).toBeVisible();
  await dialog.getByLabel("Name").fill("Summer fair");
  await dialog.getByLabel("The day").fill("2027-03-20");
  await dialog.getByRole("button", { name: "Create plan" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Created Summer fair with 18 tasks.");
  await expect(page.getByRole("heading", { name: "Summer fair" })).toBeVisible();
  await expect(page.getByText("0/18 tasks done")).toBeVisible();

  const plan = ui
    .sati<{ id: string; title: string; targetDate: string }[]>("milestone", "list")
    .find((m) => m.title === "Summer fair");
  expect(plan?.targetDate).toBe("2027-03-20");
  const tasks = ui.sati<{ title: string; dueDate?: string; dependsOn: string[] }[]>(
    "task",
    "list",
    "--milestone",
    plan?.id ?? "",
    "--limit",
    "500",
  );
  expect(tasks.find((t) => t.title === "Draft the guest list")?.dueDate).toBe("2027-01-23");
  expect(tasks.find((t) => t.title === "Book catering")?.dependsOn).toHaveLength(3);

  // The CLI makes the same plan, and a second plan of the same name is refused in the dialog.
  const cli = ui.sati<{ tasks: unknown[] }>(
    "template",
    "apply",
    "event",
    "--title",
    "Winter fair",
    "--date",
    "2027-03-20",
  );
  expect(cli.tasks).toHaveLength(18);
  await page.getByRole("button", { name: "New plan" }).click();
  await dialog.getByRole("radio", { name: /Event/ }).check();
  await dialog.getByLabel("Name").fill("summer FAIR");
  await dialog.getByRole("button", { name: "Create plan" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await problems()).toEqual([]);
});

// PLAN Phase 8: the Memory page answers from cards, edits them, and private items stay local.
test("Memory answers from cards, edits them, and keeps private ones off .sati/", async ({
  page,
  context,
}) => {
  const problems = await watch(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  ui.sati(
    "card",
    "put",
    "venue/hall-b-quote.pdf",
    "--summary",
    "Quote from Hall B for the spring fair.",
    "--facts",
    "Venue price: $2,400 for the day\nCapacity 300 seated",
    "--tags",
    "venue",
  );
  ui.sati("note", "create", "Brand voice", "--body", "Warm, short sentences.", "--pinned");
  ui.sati("note", "create", "Salary notes", "--body", "Band A is $12/hour.", "--private");

  // The board links pinned notes.
  await page.goto(ui.signIn);
  const pinned = page.getByRole("navigation", { name: "Pinned notes" });
  await expect(pinned.getByRole("link", { name: "Brand voice" })).toBeVisible();

  await page.getByRole("link", { name: "Memory", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask what the team knows" }).fill("venue price");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const answer = page.getByRole("region", { name: "Answer" });
  await expect(answer).toContainText("Venue price: $2,400 for the day");
  await answer.getByRole("button", { name: "Copy as Markdown" }).click();
  await expect(page.getByRole("status")).toContainText("Copied the answer as Markdown.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("venue/hall-b-quote.pdf");
  expect(copied).toContain("Venue price: $2,400 for the day");

  // A question nothing matches says so instead of showing an empty box.
  await page.getByRole("textbox", { name: "Ask what the team knows" }).fill("zebra parade");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(answer).toContainText("Nothing in memory matches yet");

  // Edit a shared card: the private choice is not offered for it.
  await page.getByRole("button", { name: "Edit venue/hall-b-quote.pdf" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit card" });
  await expect(dialog.getByText("Shared with the team")).toBeVisible();
  await dialog.getByLabel("Facts, one per line").fill("Venue price: $2,200 after discount");
  await dialog.getByRole("button", { name: "Save card" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Venue price: $2,200 after discount")).toBeVisible();

  // A new private card shows its badge.
  await page.getByRole("button", { name: "New card" }).click();
  const fresh = page.getByRole("dialog", { name: "New card" });
  await fresh.getByLabel("File or folder").fill("hr/pay-bands.xlsx");
  await fresh.getByLabel("Summary").fill("Pay bands for the fair staff.");
  await fresh.getByLabel("Keep on this computer only").check();
  await fresh.getByRole("button", { name: "Save card" }).click();
  await expect(fresh).toHaveCount(0);
  const hr = page.getByRole("region", { name: "hr" });
  await expect(hr.getByText("Private", { exact: true })).toBeVisible();

  // The export carries the shared card and notes, never the private ones.
  ui.sati("export");
  const exported = (dir: string) =>
    readdirSync(join(ui.repo, ".sati", dir))
      .map((f) => readFileSync(join(ui.repo, ".sati", dir, f), "utf8"))
      .join("\n");
  const cards = exported("context");
  expect(cards).toContain("$2,200 after discount");
  expect(cards).not.toContain("pay-bands");
  const notes = exported("notes");
  expect(notes).toContain("Brand voice");
  expect(notes).not.toContain("Salary notes");
  expect(await problems()).toEqual([]);
});

// Review WP6.1: a person's own Save must not look like someone else's change, and the panel
// must not leave focus on the page body.
test("saving the task panel says Saved, keeps focus on Save and shows no changed-elsewhere banner", async ({
  page,
}) => {
  const problems = await watch(page);
  const t = await ui.api<{ id: string }>("POST", "/api/tasks", {
    title: "Pack the stall",
    body: "Bring the **tent**.",
  });
  // The banner may show only for a moment, so record whether it ever appeared.
  await page.addInitScript(() => {
    const w = window as unknown as { bannerSeen: boolean };
    w.bannerSeen = false;
    document.addEventListener("DOMContentLoaded", () => {
      new MutationObserver(() => {
        if (document.body.textContent?.includes("This task changed while you were editing")) {
          w.bannerSeen = true;
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
  await page.goto(ui.signIn);
  // Earlier tests fill the board, so open the task by its link rather than hunting for the card.
  await page.goto(`${ui.origin}/?task=${t.id}`);
  const sheet = page.getByRole("dialog", { name: "Pack the stall" });
  // The body shows rendered, once; Edit details swaps in the field (owner decision, 6.2).
  await expect(sheet.locator("strong", { hasText: "tent" })).toHaveCount(1);
  await expect(sheet.getByLabel("Body")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Edit details" }).click();
  await expect(sheet.getByLabel("Body")).toBeFocused();
  await sheet.getByLabel("Body").fill("Bring the **tent** and the chairs.");
  const save = sheet.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(page.locator(".toast")).toContainText("Saved");
  await expect(sheet.getByText("and the chairs.")).toBeVisible();
  await expect(save).toBeFocused();
  expect(ui.sati<{ body: string }>("task", "show", t.id).body).toBe(
    "Bring the **tent** and the chairs.",
  );
  expect(await page.evaluate(() => (window as unknown as { bannerSeen: boolean }).bannerSeen)).toBe(
    false,
  );
  expect(await problems()).toEqual([]);
});

// Review WP6.1: a task deleted elsewhere while its panel had edits left a prompt about edits
// nobody could see.
test("an open task deleted elsewhere says so and leaves without asking", async ({ page }) => {
  const problems = await watch(page);
  const t = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Book the van" });
  await page.goto(ui.signIn);
  await page.goto(`${ui.origin}/?task=${t.id}`);
  const sheet = page.getByRole("dialog", { name: "Book the van" });
  await sheet.getByLabel("Body").fill("Ask about the big one");
  await ui.api("DELETE", `/api/tasks/${t.id}`);
  const gone = page.getByRole("dialog", { name: "Task deleted" });
  await expect(gone.getByRole("status")).toHaveText("This task was deleted.");
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await gone.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  await expect(page).toHaveURL(`${ui.origin}/notes`);
  expect(asked).toEqual([]);
  expect(await problems()).toEqual([]);
});

// PLAN 9h: approving was `card approve` only, so a person with no terminal could not sign off a
// file. The board stores the same hash, so the guard treats both approvals alike.
test("Memory approves a file as it is now and takes the approval away", async ({ page }) => {
  const problems = await watch(page);
  writeFileSync(join(ui.repo, "brief.md"), "Final brief, v3.\n");
  ui.sati("card", "put", "brief.md", "--summary", "The signed brief.");
  ui.sati("card", "put", "https://example.test/quote.pdf", "--summary", "The quote online.");
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Memory", exact: true }).click();
  // A web link has no one version to sign off.
  await expect(
    page.getByRole("button", { name: "Edit https://example.test/quote.pdf" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve https/u })).toHaveCount(0);

  await page.getByRole("button", { name: "Approve brief.md as it is now" }).click();
  await expect(page.locator(".toast")).toContainText("Approved brief.md as it is now.");
  const row = page.locator("article").filter({ hasText: "The signed brief." });
  await expect(row.getByText("Approved", { exact: true })).toBeVisible();
  // An earlier test may have given the person a display name.
  await expect(row).toContainText(/approved by .+ on \d{4}-\d{2}-\d{2}/u);
  const shown = () =>
    ui
      .sati<{ path: string; approved?: { hash: string }; approval?: string }[]>(
        "card",
        "get",
        "brief.md",
      )
      .find((c) => c.path === "brief.md");
  expect(shown()?.approved?.hash).toBe(
    createHash("sha256").update("Final brief, v3.\n").digest("hex"),
  );
  // The file changes after the sign-off: the CLI tells, from the hash the board stored.
  writeFileSync(join(ui.repo, "brief.md"), "Final brief, v4.\n");
  expect(shown()?.approval).toBe("changed");
  // And the board tells, the next time it loads: nobody has to run a command to find out.
  await page.reload();
  await page.getByRole("link", { name: "Memory", exact: true }).click();
  await expect(row.getByText("Changed since approval", { exact: true })).toBeVisible();
  await expect(row.getByText("Approved", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Remove the approval of brief.md" }).click();
  await expect(page.locator(".toast")).toContainText("brief.md is no longer approved.");
  await expect(row.getByText("Approved", { exact: true })).toHaveCount(0);
  expect(shown()?.approved).toBeUndefined();
  expect(await problems()).toEqual([]);
});

// PLAN 9h: a mention reaches a person only when the name is spelled as My work expects, so the
// comment box offers the names. Escape must close the names and leave the task open.
test("typing @ in a comment offers the project's names and puts the picked one in", async ({
  page,
}) => {
  const problems = await watch(page);
  const t = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Book the hall" });
  ui.as("dara", "person")("comment", "add", t.id, "I can call them.");
  await page.goto(ui.signIn);
  await page.goto(`${ui.origin}/?task=${t.id}`);
  const sheet = page.getByRole("dialog", { name: "Book the hall" });
  const thread = sheet.getByRole("region", { name: /^Comments/u });
  const box = thread.getByLabel("Add a comment");
  const names = thread.getByRole("listbox", { name: "Names" });
  await box.pressSequentially("Thanks @da");
  await expect(names.getByRole("option")).toHaveText(["@dara"]);
  await box.press("Escape");
  await expect(names).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await box.pressSequentially("r");
  await expect(names.getByRole("option", { selected: true })).toHaveText("@dara");
  await box.press("Enter");
  await expect(box).toHaveValue("Thanks @dara ");
  await expect(names).toHaveCount(0);
  await box.pressSequentially("please do");
  await box.press("Control+Enter");
  await expect(box).toHaveValue("");
  const said = ui.sati<{ body: string }[]>("comment", "list", t.id).map((c) => c.body);
  expect(said).toEqual(["I can call them.", "Thanks @dara please do"]);
  expect(await problems()).toEqual([]);
});

// Review WP6.1: a comment typed on Notes or Decisions was dropped without a word on navigation.
// A declined Back must also leave the history length alone (it did already; this keeps it so).
test("a typed comment on a list page asks before leaving, and a declined Back adds no history", async ({
  page,
}) => {
  const problems = await watch(page);
  await ui.api("POST", "/api/notes", { title: "Stall layout" });
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  const note = page.locator("article").filter({ hasText: "Stall layout" });
  await note.getByText("Comments", { exact: true }).click();
  await note.getByLabel("Add a comment").fill("Tables along the wall");
  const asked: string[] = [];
  page.on("dialog", (d) => {
    asked.push(d.message());
    void d.dismiss();
  });
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect.poll(() => asked).toEqual(["Discard the comment you typed?"]);
  await expect(page).toHaveURL(`${ui.origin}/notes`);
  await expect(note.getByLabel("Add a comment")).toHaveValue("Tables along the wall");

  // Back asks too; declining twice keeps the page and the history as they were.
  const length = await page.evaluate(() => history.length);
  for (const n of [2, 3]) {
    await page.goBack();
    await expect.poll(() => asked.length).toBe(n);
    await expect(page).toHaveURL(`${ui.origin}/notes`);
  }
  expect(await page.evaluate(() => history.length)).toBe(length);
  await expect(note.getByLabel("Add a comment")).toHaveValue("Tables along the wall");
  expect(await problems()).toEqual([]);
});

// Review WP6.1: the "new" highlight timer was not kept, so an older event's timer cut a newer
// highlight short.
test("a second change keeps its highlight for the full time", async ({ page }) => {
  const problems = await watch(page);
  const a = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Heron fresh A" });
  const b = await ui.api<{ id: string; version: number }>("POST", "/api/tasks", {
    title: "Heron fresh B",
  });
  await page.goto(ui.signIn);
  await page.getByLabel("Filter tasks").fill("Heron fresh");
  const fresh = (title: string) =>
    page.locator(".card.fresh").filter({ has: page.getByRole("button", { name: title }) });
  await ui.api("PATCH", `/api/tasks/${a.id}`, { priority: "high" });
  await expect(fresh("Heron fresh A")).toHaveCount(1);
  await page.waitForTimeout(1000);
  await ui.api("PATCH", `/api/tasks/${b.id}`, { priority: "high", expectedVersion: b.version });
  await expect(fresh("Heron fresh B")).toHaveCount(1);
  // A's timer ends 1.6 s after A, under 0.6 s from now; B's own runs a full 1.6 s.
  await page.waitForTimeout(1000);
  await expect(fresh("Heron fresh B")).toHaveCount(1, { timeout: 50 });
  expect(await problems()).toEqual([]);
});

// Review WP6.2: actions that said nothing, or said the wrong thing, now say what happened.
test("the board says what happened after each action, and a removed step has Undo", async ({
  page,
}) => {
  const problems = await watch(page);
  const toast = page.locator('.toast-region[role="status"]');
  const t = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Set up the tables" });
  // Copying fails here as it does when the browser blocks the clipboard.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("blocked")) },
    });
  });
  await page.goto(ui.signIn);
  await page.goto(`${ui.origin}/?task=${t.id}`);
  const sheet = page.getByRole("dialog", { name: "Set up the tables" });
  await sheet.getByLabel("New step").fill("Count the chairs");
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  await sheet.getByRole("button", { name: "Remove step Count the chairs" }).click();
  const steps = sheet.getByRole("checkbox", { name: "Count the chairs" });
  const saved = () => ui.sati<{ checklist: { text: string }[] }>("task", "show", t.id).checklist;
  await expect(steps).toHaveCount(0);
  await expect(toast).toContainText("Removed the step Count the chairs.");
  // Once the removal is saved, the step must stay gone: a snapshot from before the save used to
  // bring it back for a moment, and Undo then added it a second time.
  await expect.poll(saved).toEqual([]);
  await expect(steps).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(steps).toHaveCount(1);
  await expect.poll(saved).toEqual([expect.objectContaining({ text: "Count the chairs" })]);

  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "Free up tasks whose time ran out" }).click();
  await expect(toast).toContainText("No tasks had run out of time.");

  await page.getByRole("link", { name: "Notes", exact: true }).click();
  await page.getByLabel("Note title").fill("Table plan");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(toast).toContainText("Saved the note Table plan.");

  // A clipboard failure is a copy problem, not "That change did not save".
  await page.getByRole("link", { name: "Changes", exact: true }).click();
  await page.getByRole("button", { name: "Copy changelog" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not copy. Select the text and copy it by hand.",
  );

  // A change opens its item, not just the list it is on.
  await page
    .getByRole("region", { name: "Today" })
    .getByRole("button", { name: "Table plan", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(`${ui.origin}/notes`);
  await expect(page.locator("article:focus")).toContainText("Table plan");

  // The effort choice explains what light means.
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await expect(form.getByLabel("Effort")).toHaveAccessibleDescription(
    "Light tasks can go to a faster, cheaper agent.",
  );
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  expect(await problems()).toEqual([]);
});

// Review WP6.2: the palette showed old hits for new text and never said it stops at 20.
test("the palette clears hits when the text changes and says when results stop at 20", async ({
  page,
}) => {
  for (let i = 1; i <= 21; i++) await ui.api("POST", "/api/tasks", { title: `Lantern ${i}` });
  await page.goto(ui.signIn);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search" });
  const input = palette.getByRole("textbox", { name: "Search" });
  await input.fill("lantern");
  await input.press("Enter");
  await expect(palette.getByRole("status")).toHaveText("First 20 results");
  await input.fill("lanterns and candles");
  await expect(palette.getByRole("button", { name: /Lantern/u })).toHaveCount(0);
  await expect(palette.getByRole("status")).toHaveText("Press Enter to search.");
});

// Audit 2026-11-11: the second move of a card went out with the version from before the first,
// so the server refused it and the card jumped back with a conflict message.
test("moving one card twice before the first move lands keeps both moves", async ({ page }) => {
  const problems = await watch(page);
  const task = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Osprey twice" });
  await page.goto(ui.signIn);
  await page.getByLabel("Filter tasks").fill("Osprey twice");
  // Hold every save for a moment, so the second move starts while the first is in flight.
  await page.route(`**/api/tasks/${task.id}`, async (route) => {
    await new Promise((done) => setTimeout(done, 300));
    await route.continue();
  });
  const box = page.locator(".card", {
    has: page.getByRole("button", { name: "Osprey twice", exact: true }),
  });
  await box.getByRole("button", { name: "select" }).click();
  await page.getByLabel("Move selected").selectOption("in_progress");
  await page.getByLabel("Move selected").selectOption("todo");
  const status = async () =>
    (
      await ui.api<{ tasks: { id: string; status: string; version: number }[] }>(
        "GET",
        "/api/snapshot",
      )
    ).tasks.find((t) => t.id === task.id);
  // Version 3: both moves were saved, in order.
  await expect.poll(status).toMatchObject({ status: "todo", version: 3 });
  await expect(page.getByRole("alert").locator(".toast")).toHaveCount(0);
  await expect(
    column(page, "To do").getByRole("button", { name: "Osprey twice", exact: true }),
  ).toBeVisible();
  expect(await problems()).toEqual([]);
});

// Audit 2026-11-11: Esc was handled on the form, so it did nothing once focus had left it.
test("Esc closes a form dialog when focus is outside its form", async ({ page }) => {
  await page.goto(ui.signIn);
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await form.getByLabel("Title").fill("Typed and then abandoned");
  // A click on the backdrop keeps typed text, and leaves focus on the backdrop.
  await page.locator(".palette-dismiss").click({ position: { x: 4, y: 4 } });
  await expect(form).toBeVisible();
  page.once("dialog", (ask) => void ask.accept());
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
});

// Audit 2026-11-11: x and Enter are board keys. On another page x selected a card nobody saw,
// and the next bulk move on the board took it along.
test("x on a page other than the board selects nothing", async ({ page }) => {
  const task = await ui.api<{ id: string }>("POST", "/api/tasks", { title: "Plover unseen" });
  await page.goto(ui.signIn);
  await page.goto(`${ui.origin}/notes?task=${task.id}`);
  // A click on plain text takes focus out of the task panel, as reading the page does.
  await page.getByRole("heading", { name: "Notes", level: 1 }).click();
  await page.keyboard.press("x");
  await page.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByLabel("Filter tasks")).toBeVisible();
  await expect(page.getByText("1 selected")).toHaveCount(0);
});

// Review WP6.2: "just now" stayed until a write refreshed the page.
test("relative times tick each minute without a write", async ({ page }) => {
  await page.clock.install();
  ui.sati("note", "create", "Hang the banner");
  await page.goto(ui.signIn);
  await page.getByRole("link", { name: "Notes", exact: true }).click();
  const card = page.locator("article").filter({ hasText: "Hang the banner" });
  await expect(card).toContainText("just now");
  await page.clock.fastForward("01:05");
  await expect(card).toContainText("1 min ago");
});

// Review 1.2: a checkbox in each column header selects every task the filter leaves in that
// column, including the ones the virtual list has not drawn.
test("select all in a column selects every task in it, drawn or not", async ({ page }) => {
  const own = await startUi();
  try {
    for (let from = 0; from < 200; from += 25) {
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          own.api("POST", "/api/tasks", { title: `Bulk task ${from + i}` }),
        ),
      );
    }
    await page.goto(own.signIn);
    const todo = column(page, "To do");
    const all = todo.getByRole("checkbox", { name: "Select all in To do" });
    await expect(all).not.toBeChecked();
    await all.check();
    await expect(page.getByText("200 selected")).toBeVisible();
    await expect(all).toBeChecked();
    await all.uncheck();
    await expect(page.getByText("200 selected")).toHaveCount(0);
    // One card selected by hand shows the box as mixed; the next click selects the rest.
    await todo.locator(".card").first().getByRole("button", { name: "select" }).click();
    await expect(all).toHaveJSProperty("indeterminate", true);
    await all.check();
    await expect(page.getByText("200 selected")).toBeVisible();
  } finally {
    await own.stop();
  }
});

// Review 1.3 (D2): at laptop width every open column is on screen without sideways scrolling;
// Backlog and Cancelled start as narrow rails that still show their count and take a drop.
test.describe("columns that fit", () => {
  let own: Ui;
  test.beforeAll(async () => {
    own = await startUi();
    for (const title of ["Rail one", "Rail two"])
      await own.api("POST", "/api/tasks", { title, status: "backlog" });
    await own.api("POST", "/api/tasks", { title: "Drop me", status: "todo" });
  });
  test.afterAll(async () => {
    await own?.stop();
  });

  test("at 1400 × 900 every open column is fully inside the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(own.signIn);
    const open = page.locator(".column:not(.collapsed)");
    await expect(open).toHaveCount(5);
    for (const box of await open.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().toJSON()),
    )) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(1400);
    }
    const board = page.locator(".board");
    expect(await board.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test("a collapsed column still shows its count and takes a drop", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(own.signIn);
    const rail = column(page, "Backlog");
    await expect(rail).toHaveClass(/collapsed/u);
    const show = rail.getByRole("button", { name: "Show Backlog, 2 tasks" });
    await expect(show).toHaveAttribute("aria-expanded", "false");
    await expect(rail.locator(".card")).toHaveCount(0);

    // Drag To do's card onto the rail: the rail counts it.
    const from = await page
      .getByRole("button", { name: "Move Drop me", exact: true })
      .boundingBox();
    const to = await rail.boundingBox();
    if (!from || !to) throw new Error("card or rail is not on the page");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 12 });
    await page.mouse.up();
    await expect(rail.getByRole("button", { name: "Show Backlog, 3 tasks" })).toBeVisible();

    // The choice to open a column is remembered by this browser.
    await rail.getByRole("button", { name: /^Show Backlog/u }).click();
    await expect(column(page, "Backlog")).not.toHaveClass(/collapsed/u);
    await page.reload();
    await expect(column(page, "Backlog")).not.toHaveClass(/collapsed/u);
  });
});

test("an old /activity link lands on the Log tab of Changes", async ({ page }) => {
  await page.goto(ui.signIn);
  await page.goto(`${ui.origin}/activity`);
  await expect(page).toHaveURL(/\/changes\?tab=log$/u);
  await expect(page.getByRole("tab", { name: "Log", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
  // Arrow keys move between the tabs, and the address follows.
  await page.getByRole("tab", { name: "Log", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Changes", exact: true })).toBeFocused();
  await expect(page).toHaveURL(/\/changes$/u);
});
