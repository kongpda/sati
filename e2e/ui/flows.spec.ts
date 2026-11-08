import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

  // The New task form creates a task with its details; a blank title cannot be sent.
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await expect(form.getByLabel("Title")).toBeFocused();
  await expect(form.getByRole("button", { name: "Create task" })).toBeDisabled();
  await form.getByLabel("Title").fill("Write the release notes");
  await form.getByLabel("Priority").selectOption("high");
  await form.getByLabel("Labels").fill("launch, docs, launch");
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form).toHaveCount(0);
  const card = page.getByRole("button", { name: "Write the release notes", exact: true });
  await expect(card).toBeVisible();
  const created = ui
    .sati<{ title: string; priority: string; labels: string[] }[]>("task", "list")
    .find((t) => t.title === "Write the release notes");
  expect(created).toMatchObject({ priority: "high", labels: ["launch", "docs"] });

  // `c` opens the same form without typing the letter into it; Esc closes it unsaved. Focus went
  // back to the New task button, and shortcuts skip a focused button, so leave it first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  await expect(form.getByLabel("Title")).toHaveValue("");
  await form.getByLabel("Title").fill("Not saved");
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
  // whole-board rollback from one would bring back the other's refused state.
  for (const title of titles) await pick(title);
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByLabel("Move selected").selectOption("review");
  await expect(page.getByRole("status").locator(".toast")).toContainText(
    "2 of 2 tasks did not move.",
  );
  const todo = column(page, "To do");
  for (const title of titles)
    await expect(todo.getByRole("button", { name: title, exact: true })).toBeVisible();
  await expect(column(page, "Waiting for approval").locator(".card")).toHaveCount(0);
  expect(await statuses()).toEqual(["todo", "todo"]);

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
    "Activity",
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

  await page.getByRole("link", { name: "Activity", exact: true }).click();
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

  await approval.getByRole("button", { name: "Approve Proof the flyer" }).click();
  await expect(page.getByRole("status")).toContainText("Approved Proof the flyer.");
  await expect(approval).not.toContainText("Proof the flyer");

  // Sending back needs a reason; the next claimer sees it.
  await approval.getByRole("button", { name: "Send back Check the guest list" }).click();
  await approval.getByLabel("Why Check the guest list needs more work").fill("Add the press list.");
  await approval.getByRole("button", { name: "Send back", exact: true }).click();
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
  await page.getByRole("link", { name: "Activity", exact: true }).click();
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

  await page.getByRole("link", { name: "Activity", exact: true }).click();
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
  const choice = page.getByLabel("Column", { exact: true });
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
