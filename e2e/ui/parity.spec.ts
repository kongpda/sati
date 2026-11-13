import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, type Page, test } from "@playwright/test";
import { openKnowledge } from "./nav.js";
import { bin, startUi, type Ui } from "./server.js";
import { watch } from "./watch.js";

// PLAN Phase 7a, "Two ways to work, one memory": each capability is done once by a person
// clicking in the UI and once by an agent over MCP, in the same repo, and both must leave the
// same records. Both are read back through the CLI, so the comparison sees what was stored.

type Rec = { id: string; title: string; createdBy: string } & Record<string, unknown>;
type Side = "ui" | "mcp";

let ui: Ui;
let mcp: Client;
test.beforeAll(async () => {
  ui = await startUi();
  mcp = new Client({ name: "parity", version: "0.0.0" });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp"],
      cwd: ui.repo,
      env: { ...ui.env, SATI_ACTOR: "claude-code@main#1", CLAUDECODE: "1" },
      stderr: "pipe",
    }),
  );
});
test.afterAll(async () => {
  await mcp?.close();
  await ui?.stop();
});

/**
 * Calls an MCP tool and returns its parsed JSON result. Results come in a ```data fence under a
 * notice line (review 4.2), so teammate text is never read as instructions; the JSON is inside.
 */
async function call<T = Rec>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await mcp.callTool({ name, arguments: args });
  const [first] = res.content as { type: string; text?: string }[];
  if (res.isError || first?.type !== "text") throw new Error(`${name}: ${first?.text}`);
  const fenced = /\n```data\n([\s\S]*)\n```\n$/u.exec(first.text ?? "");
  if (!fenced?.[1]) throw new Error(`${name}: result is not fenced: ${first.text}`);
  return JSON.parse(fenced[1]) as T;
}

// Distinct titles per run and side, so each side's records are found by title.
const run = Date.now().toString(36);
const named = (side: Side, text: string) => `${text} (${side}-${run})`;

/** Fields that must differ between the two ways: identity, clocks, the claim's lease. */
const DROP = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "createdBy",
  "version",
  "stamps",
  "leaseUntil",
  "heartbeatAt",
  "token",
  // Only the long-lived MCP server names its process as a claim's holder; a person in the UI has none.
  "holder",
  // Milestones are numbered in creation order, so the second one made is always one later.
  "order",
]);

/**
 * `record` without the fields that must differ, with the side's title suffix and the ids in
 * `refs` (the side's own records and actor) replaced by role names, so links still compare.
 */
function normalise(value: unknown, side: Side, refs: Record<string, string> = {}): unknown {
  if (typeof value === "string") return refs[value] ?? value.replaceAll(`${side}-${run}`, "<run>");
  if (Array.isArray(value)) return value.map((v) => normalise(v, side, refs));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !DROP.has(key))
      .map(([key, v]) => [key, normalise(v, side, refs)]),
  );
}

/** The one record of `kind` with this title, as the CLI shows it. */
function byTitle(kind: "task" | "milestone" | "note" | "decision", title: string): Rec {
  const found = ui.sati<Rec[]>(kind, "list").find((r) => r.title === title);
  if (!found) throw new Error(`No ${kind} titled ${title}`);
  return ui.sati<Rec>(kind, "show", found.id);
}

/** Opens the board signed in, and returns a check for CSP violations and page errors. */
async function board(page: Page) {
  const problems = await watch(page);
  await page.goto(ui.signIn);
  return problems;
}

test("task: create with details, priority, due date, labels and a plan; rename and move", async ({
  page,
}) => {
  const plan = ui.sati<{ id: string }>("milestone", "create", `Spring launch ${run}`);
  const details = "Print **200** copies.";

  const problems = await board(page);
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await form.getByLabel("Title").fill(named("ui", "Print the programme"));
  await form.getByLabel("Details").fill(details);
  await form.getByLabel("Priority").selectOption("high");
  await form.getByLabel("Due date").fill("2026-12-04");
  await form.getByLabel("Plan").selectOption({ label: `Spring launch ${run}` });
  await form.getByLabel("Labels").fill("print, launch, print");
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole("button", { name: named("ui", "Print the programme"), exact: true }).click();
  const sheet = page.getByRole("dialog", { name: named("ui", "Print the programme") });
  await sheet.getByLabel("Title").fill(named("ui", "Print the final programme"));
  await sheet.getByLabel("Status").selectOption("in_progress");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Working on it", exact: true })
      .getByRole("button", { name: named("ui", "Print the final programme"), exact: true }),
  ).toBeVisible();
  expect(await problems()).toEqual([]);

  const made = await call("task_create", {
    title: named("mcp", "Print the programme"),
    body: details,
    priority: "high",
    dueDate: "2026-12-04",
    milestoneId: plan.id,
    labels: ["print", "launch"],
  });
  const moved = await call("task_update", {
    id: made.id,
    title: named("mcp", "Print the final programme"),
    status: "in_progress",
    expectedVersion: made.version,
  });
  expect(moved.status).toBe("in_progress");

  const byUi = byTitle("task", named("ui", "Print the final programme"));
  const byMcp = ui.sati<Rec>("task", "show", made.id);
  expect(byMcp.createdBy).not.toBe(byUi.createdBy);
  expect(byUi).toMatchObject({
    body: details,
    priority: "high",
    dueDate: "2026-12-04",
    milestoneId: plan.id,
    labels: ["print", "launch"],
    status: "in_progress",
  });
  // Moving to in_progress claims the task for whoever moved it, on both sides.
  expect(normalise(byMcp, "mcp", { [byMcp.createdBy]: "me" })).toEqual(
    normalise(byUi, "ui", { [byUi.createdBy]: "me" }),
  );
});

test("checklist: add two steps and tick one", async ({ page }) => {
  const problems = await board(page);
  await page.getByRole("button", { name: "New task" }).click();
  const form = page.getByRole("dialog", { name: "New task" });
  await form.getByLabel("Title").fill(named("ui", "Send the invitations"));
  await form.getByRole("button", { name: "Create task" }).click();
  await expect(form).toHaveCount(0);
  await page
    .getByRole("button", { name: named("ui", "Send the invitations"), exact: true })
    .click();
  const sheet = page.getByRole("dialog", { name: named("ui", "Send the invitations") });
  for (const step of ["Guest list", "Print cards"]) {
    await sheet.getByLabel("New step").fill(step);
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await expect(sheet.getByRole("checkbox", { name: step })).toBeVisible();
  }
  await sheet.getByRole("checkbox", { name: "Guest list" }).check();
  await expect(sheet.getByRole("heading", { name: "Checklist · 1/2" })).toBeVisible();
  expect(await problems()).toEqual([]);

  const made = await call("task_create", { title: named("mcp", "Send the invitations") });
  const added = await call("task_update", {
    id: made.id,
    checklist: [
      { text: "Guest list", done: false },
      { text: "Print cards", done: false },
    ],
    expectedVersion: made.version,
  });
  await call("task_update", {
    id: made.id,
    checklist: [
      { text: "Guest list", done: true },
      { text: "Print cards", done: false },
    ],
    expectedVersion: added.version,
  });

  // Each tick in the UI saves at once, in order; wait for the last one to land.
  const uiTask = () => byTitle("task", named("ui", "Send the invitations"));
  await expect
    .poll(() => uiTask().checklist)
    .toEqual([
      { text: "Guest list", done: true },
      { text: "Print cards", done: false },
    ]);
  expect(normalise(ui.sati<Rec>("task", "show", made.id), "mcp")).toEqual(
    normalise(uiTask(), "ui"),
  );
});

test("milestone: create with a goal and target date, then change its status", async ({ page }) => {
  const problems = await board(page);
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await page.getByRole("button", { name: "New milestone" }).click();
  const create = page.getByRole("dialog", { name: "New milestone" });
  await create.getByLabel("Name").fill(named("ui", "Launch event"));
  await create.getByLabel("Goal").fill("Guests in the room by 7 pm.");
  await create.getByLabel("Target date").fill("2026-12-04");
  await create.getByRole("button", { name: "Create milestone" }).click();
  await expect(create).toHaveCount(0);
  await page.getByRole("button", { name: `Edit ${named("ui", "Launch event")}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit milestone" });
  await edit.getByLabel("Status").selectOption("active");
  await edit.getByRole("button", { name: "Save milestone" }).click();
  await expect(edit).toHaveCount(0);
  expect(await problems()).toEqual([]);

  const made = await call("milestone_upsert", {
    title: named("mcp", "Launch event"),
    goal: "Guests in the room by 7 pm.",
    targetDate: "2026-12-04",
  });
  await call("milestone_upsert", { id: made.id, status: "active", expectedVersion: made.version });

  const byUi = byTitle("milestone", named("ui", "Launch event"));
  expect(byUi).toMatchObject({ status: "active", targetDate: "2026-12-04" });
  expect(normalise(ui.sati<Rec>("milestone", "show", made.id), "mcp")).toEqual(
    normalise(byUi, "ui"),
  );
});

test("note: create with a body and tags, pin it, edit it", async ({ page }) => {
  const title = (side: Side) => named(side, "Venue options");
  const problems = await board(page);
  await openKnowledge(page, "Notes");
  // The UI's quick form takes a title and body; tags are added in the edit dialog.
  await page.getByLabel("Note title").fill(title("ui"));
  await page.getByLabel("Note body").fill("Riverside hall.");
  await page.getByRole("button", { name: "Save note" }).click();
  await page.getByRole("button", { name: `Edit ${title("ui")}` }).click();
  const edit = page.getByRole("dialog", { name: "Edit note" });
  await edit.getByLabel("Tags").fill("venue, launch");
  await edit.getByRole("button", { name: "Save note" }).click();
  await expect(edit).toHaveCount(0);
  await page.getByRole("button", { name: `Pin ${title("ui")}` }).click();
  await expect(page.getByRole("button", { name: `Unpin ${title("ui")}` })).toBeVisible();
  await page.getByRole("button", { name: `Edit ${title("ui")}` }).click();
  await edit.getByLabel("Body").fill("Riverside hall, rooftop.");
  await edit.getByRole("button", { name: "Save note" }).click();
  await expect(edit).toHaveCount(0);
  expect(await problems()).toEqual([]);

  const made = await call("note_upsert", {
    title: title("mcp"),
    body: "Riverside hall.",
    tags: ["venue", "launch"],
  });
  const pinned = await call("note_upsert", {
    id: made.id,
    pinned: true,
    expectedVersion: made.version,
  });
  await call("note_upsert", {
    id: made.id,
    body: "Riverside hall, rooftop.",
    expectedVersion: pinned.version,
  });

  const byUi = byTitle("note", title("ui"));
  expect(byUi).toMatchObject({
    body: "Riverside hall, rooftop.",
    tags: ["venue", "launch"],
    pinned: true,
  });
  const byMcp = await call<Rec>("note_get", { id: made.id });
  expect(byMcp).toEqual(ui.sati<Rec>("note", "show", made.id));
  expect(normalise(byMcp, "mcp")).toEqual(normalise(byUi, "ui"));
});

test("decision: record one with context, then replace it", async ({ page }) => {
  const first = (side: Side) => named(side, "Hold the launch at the riverside venue");
  const second = (side: Side) => named(side, "Hold the launch on the rooftop");
  const problems = await board(page);
  await openKnowledge(page, "Decisions");
  await page.getByRole("button", { name: "Record decision", exact: true }).click();
  const record = page.getByRole("dialog", { name: "Record decision" });
  await record.getByLabel("Title").fill(first("ui"));
  await record.getByLabel("Decision", { exact: true }).fill("Book the riverside hall.");
  await record.getByLabel("Context").fill("The hotel was full.");
  await record.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(record).toHaveCount(0);
  await page.getByRole("button", { name: `Replace ${first("ui")}` }).click();
  const replace = page.getByRole("dialog", { name: "Replace decision" });
  await replace.getByLabel("Title").fill(second("ui"));
  await replace.getByLabel("Decision", { exact: true }).fill("The hall flooded; use the rooftop.");
  await replace.getByRole("button", { name: "Record decision", exact: true }).click();
  await expect(replace).toHaveCount(0);
  await expect(page.getByText(`Superseded by ${second("ui")}`)).toBeVisible();
  expect(await problems()).toEqual([]);

  const old = await call("decision_record", {
    title: first("mcp"),
    decision: "Book the riverside hall.",
    context: "The hotel was full.",
  });
  await call("decision_record", {
    title: second("mcp"),
    decision: "The hall flooded; use the rooftop.",
    supersedes: old.id,
  });

  // One read for all four: each `show` would start the CLI again.
  const decisions = ui.sati<Rec[]>("decision", "list");
  const pair = (side: Side) => {
    const before = decisions.find((d) => d.title === first(side));
    const after = decisions.find((d) => d.title === second(side));
    if (!before || !after) throw new Error(`The ${side} decisions are missing.`);
    expect(after.supersedes).toBe(before.id);
    return normalise([before, after], side, { [before.id]: "first" });
  };
  expect(decisions.find((d) => d.title === first("ui"))).toMatchObject({
    context: "The hotel was full.",
  });
  expect(pair("mcp")).toEqual(pair("ui"));
});

test("comment: on a task, from the UI thread and from note_upsert", async ({ page }) => {
  const onUi = ui.sati<Rec>("task", "create", named("ui", "Order the banners"));
  const onMcp = ui.sati<Rec>("task", "create", named("mcp", "Order the banners"));
  const said = "Use the **matte** paper.";

  const problems = await board(page);
  await page.getByRole("button", { name: onUi.title, exact: true }).click();
  const thread = page
    .getByRole("dialog", { name: onUi.title })
    .getByRole("region", { name: /^Comments/u });
  await thread.getByLabel("Add a comment").fill(said);
  await thread.getByLabel("Add a comment").press("Control+Enter");
  await expect(thread.getByRole("heading", { name: "Comments · 1" })).toBeVisible();
  expect(await problems()).toEqual([]);

  await call("note_upsert", { body: said, tags: ["comment"], links: [onMcp.id] });

  const [byUi] = ui.sati<Rec[]>("comment", "list", onUi.id);
  const [byMcp] = ui.sati<Rec[]>("comment", "list", onMcp.id);
  expect(byUi).toMatchObject({ body: said, tags: ["comment"], links: [onUi.id] });
  expect(normalise(byMcp, "mcp", { [onMcp.id]: "task" })).toEqual(
    normalise(byUi, "ui", { [onUi.id]: "task" }),
  );
});
