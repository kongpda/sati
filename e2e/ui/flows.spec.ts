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
  await expect(page.locator(".toast[role=status]")).toContainText("2 of 2 tasks did not move.");
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
    "Decisions",
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
  await edit.getByLabel("Pin to the top of Notes").check();
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
  await sheet.getByRole("checkbox", { name: "Guest list" }).check();
  await expect(sheet.getByRole("heading", { name: "Checklist · 1/2" })).toBeVisible();
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
  >("task", "list", "--assignee", "me");
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
