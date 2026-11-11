import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { shortHandle } from "../domain/ids.js";
import { IsoDay, LIMITS, type Milestone, type Task } from "../domain/schemas.js";
import { refuseSecrets } from "../domain/secrets.js";
import { CLI_NAME } from "../name.js";
import type { StorageReader, StorageWriter } from "../ports/storage.js";
import { listAll, parseInput, type ServiceContext } from "./context.js";
import { CreateMilestoneInput, createMilestoneIn } from "./milestone.js";
import { CreateTaskInput, createTaskIn } from "./task.js";

/** Where a project keeps its own templates, inside its `.sati/` folder. */
export const TEMPLATE_DIR = "templates";
/** A template file larger than this is not read. */
export const TEMPLATE_MAX_BYTES = 200_000;
const MAX_TASKS = 300;
const MAX_STEPS = 100;
export const TemplateName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,40}$/u, "use lowercase letters, digits and dashes");

/** A template's Markdown and where it came from; adapters read the project's files. */
export interface TemplateFile {
  name: string;
  markdown: string;
  /** `built-in`, or the file it was read from, such as `.sati/templates/event.md`. */
  source: string;
}

export interface TemplateStage {
  title: string;
  /** Days from the plan's target date (negative is before), or `null` for no due date. */
  offsetDays: number | null;
  tasks: { title: string; checklist: string[] }[];
}

export interface Template {
  name: string;
  title: string;
  goal: string;
  labels: string[];
  stages: TemplateStage[];
  source: string;
  /** The Markdown it was read from, for `sati template show`. */
  markdown: string;
}

/** A short form for lists and pickers. */
export interface TemplateSummary {
  name: string;
  title: string;
  goal: string;
  source: string;
  tasks: number;
  stages: { title: string; offsetDays: number | null; tasks: number }[];
}

/**
 * The starters. A file with the same name in `.sati/templates/` replaces one; `sati
 * template show <name>` prints one to copy and edit.
 */
const STARTERS: Record<string, string> = {
  event: `# Event
Goal: The event happens on the day, on budget, and guests know what to expect.
Labels: event

## Plan (-8w)
- [ ] Set the date, budget and goal
- [ ] Draft the guest list
- [ ] Choose the venue
  - [ ] Shortlist three venues
  - [ ] Visit or call each one
  - [ ] Compare price, size and access

## Book (-6w)
- [ ] Book the venue and pay the deposit
- [ ] Book catering
- [ ] Confirm speakers or hosts

## Invite (-4w)
- [ ] Send the invitations
- [ ] Publish the event page or post
- [ ] Order printing: signs, badges, flyers

## Prepare (-1w)
- [ ] Confirm numbers with the venue and catering
- [ ] Write the run sheet for the day
- [ ] Brief the team and volunteers
- [ ] Send guests a reminder with directions

## On the day (0d)
- [ ] Set up and check sound, screens and signs
- [ ] Welcome guests and run the agenda

## After (+1w)
- [ ] Send thank-you notes
- [ ] Pay the final invoices
- [ ] Write up what worked and what to change
`,
  campaign: `# Marketing campaign
Goal: Reach the audience with one clear message, and measure what it brought.
Labels: campaign

## Brief (-6w)
- [ ] Write the brief: audience, message, goal and budget
- [ ] Agree how success is measured
- [ ] Get the brief approved

## Create (-4w)
- [ ] Write the copy
- [ ] Design the visuals
- [ ] Prepare the landing page
- [ ] Set up tracking links

## Review (-2w)
- [ ] Review copy and visuals with the approver
  - [ ] Copy
  - [ ] Visuals
  - [ ] Landing page
- [ ] Check legal and brand rules
- [ ] Schedule posts, emails and ads

## Launch (0d)
- [ ] Go live on every channel
- [ ] Answer comments and questions

## Measure (+2w)
- [ ] Collect results against the goal
- [ ] Share a short report with the team
`,
  release: `# Product release
Goal: Ship tested changes with clear release notes and no surprises for users.
Labels: release

## Scope (-4w)
- [ ] Agree what is in and out of this release
- [ ] Record the scope as a decision
- [ ] Mark the features it ships as building

## Build (-2w)
- [ ] Finish the planned features
- [ ] Write or update tests for each change
- [ ] Update the docs for changed behaviour

## Freeze (-1w)
- [ ] Freeze the scope: only fixes from now on
- [ ] Run the full test suite and fix failures
- [ ] Test the upgrade from the last release
- [ ] Check performance and security
- [ ] Write the changelog: \`${CLI_NAME} changes --format changelog\`

## Release (0d)
- [ ] Bump the version and tag the release
- [ ] Publish the packages or deploy
- [ ] Mark the shipped features as shipped
- [ ] Announce the release

## Follow up (+1w)
- [ ] Watch error reports and support questions
- [ ] Fix urgent issues in a patch release
- [ ] Write up what to change next time
`,
  "content-calendar": `# Content calendar
Goal: A month of posts is planned, approved and scheduled before the month starts.
Labels: content

## Plan (-3w)
- [ ] Review last month: what worked and what did not
- [ ] Pick the themes and key dates for the month
- [ ] List the posts: channel, date, topic and owner

## Create (-2w)
- [ ] Write the copy for each post
- [ ] Make the visuals and videos
- [ ] Collect links, tags and tracking codes

## Approve (-1w)
- [ ] Review the posts with the approver
  - [ ] Copy
  - [ ] Visuals
  - [ ] Dates and channels
- [ ] Fix what the review found

## Schedule (0d)
- [ ] Schedule every post
- [ ] Share the calendar with the team

## Measure (+5w)
- [ ] Collect reach and results per post
- [ ] Note what to repeat next month
`,
  "monthly-report": `# Monthly report
Goal: The report is correct, reviewed and sent on the due date.
Labels: report

## Collect (-7d)
- [ ] Ask each owner for their numbers and notes
- [ ] Export the data from each source
- [ ] Check the numbers against last month

## Draft (-4d)
- [ ] Update the spreadsheet and charts
- [ ] Write the summary: results, reasons, next steps
- [ ] Build the slides or document

## Review (-2d)
- [ ] Review with the approver
  - [ ] Numbers match the sources
  - [ ] Charts are readable
  - [ ] Summary says what changed and why
- [ ] Fix what the review found

## Send (0d)
- [ ] Export the final file and send it
- [ ] Save the final file and its sources in the project folder
`,
  proposal: `# Proposal
Goal: The client gets a clear, approved proposal before the deadline.
Labels: proposal

## Understand (-3w)
- [ ] Read the request and list what the client asks for
- [ ] Ask the client the open questions
- [ ] Decide to bid or not, and record why

## Draft (-2w)
- [ ] Outline the proposal
- [ ] Write the approach and scope
- [ ] Build the budget and timeline
- [ ] Add the team, references and case studies

## Review (-1w)
- [ ] Review with the approver
  - [ ] Scope and price
  - [ ] Legal terms
  - [ ] Spelling and layout
- [ ] Fix what the review found

## Send (0d)
- [ ] Export the final file and send it
- [ ] Confirm the client received it

## Follow up (+1w)
- [ ] Ask the client for a decision or feedback
- [ ] Record the result and what to change next time
`,
  "meeting-notes": `# Meeting
Goal: People come prepared, decisions are written down, and every action has an owner.
Labels: meeting

## Prepare (-3d)
- [ ] Write the agenda and the goal of the meeting
- [ ] Send the invitation with the agenda and files to read

## Meet (0d)
- [ ] Take notes: decisions, actions, owners and dates

## After (+1d)
- [ ] Save the notes as a note, and each decision as a decision
- [ ] Create a task for each action, with its owner and due date
- [ ] Send the notes to everyone invited
`,
};

export const STARTER_TEMPLATES: readonly TemplateFile[] = Object.entries(STARTERS).map(
  ([name, markdown]) => ({ name, markdown, source: "built-in" }),
);

/** `(-6w)`, `(+3d)` or `(0d)` at the end of a stage heading. */
const OFFSET = /\s*\(([+-]?)(\d{1,3})([dw])\)\s*$/u;

/**
 * Reads a template: `# Name`, optional `Goal:` and `Labels:` lines, then `## Stage (-6w)`
 * headings with `- [ ] task` lines; an indented `- [ ]` under a task is a step of its
 * checklist. Tasks before the first stage form a stage of their own. Anything else is ignored,
 * so a template can carry notes for the person editing it.
 */
export function parseTemplate(file: TemplateFile): Template {
  const out: Template = {
    name: file.name,
    title: file.name,
    goal: "",
    labels: [],
    stages: [],
    source: file.source,
    markdown: file.markdown,
  };
  let stage: TemplateStage | undefined;
  let task: TemplateStage["tasks"][number] | undefined;
  for (const raw of file.markdown.split(/\r?\n/u)) {
    const line = raw.trim();
    const h1 = /^#\s+(.+)$/u.exec(line);
    if (h1?.[1] && out.stages.length === 0 && stage === undefined) {
      out.title = h1[1].trim();
      continue;
    }
    const h2 = /^#{2,6}\s+(.+)$/u.exec(line);
    if (h2?.[1]) {
      const offset = OFFSET.exec(h2[1]);
      const n = offset ? Number(offset[2]) * (offset[3] === "w" ? 7 : 1) : null;
      stage = {
        title: h2[1].replace(OFFSET, "").trim(),
        offsetDays: n === null ? null : offset?.[1] === "-" ? -n : n,
        tasks: [],
      };
      out.stages.push(stage);
      task = undefined;
      continue;
    }
    const meta = /^(goal|labels):\s*(.*)$/iu.exec(line);
    if (meta && !stage) {
      const value = (meta[2] ?? "").trim();
      if (meta[1]?.toLowerCase() === "goal") out.goal = value;
      else
        out.labels = value
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
      continue;
    }
    const box = /^[-*]\s+\[\s\]\s+(.+)$/u.exec(line);
    if (!box?.[1]) continue;
    const text = box[1].trim();
    // Indented under a task: a checklist step, not a task of its own.
    if (task && /^\s{2,}|^\t/u.test(raw)) {
      task.checklist.push(text);
      continue;
    }
    if (!stage) {
      stage = { title: "Start", offsetDays: null, tasks: [] };
      out.stages.push(stage);
    }
    task = { title: text, checklist: [] };
    stage.tasks.push(task);
  }
  out.stages = out.stages.filter((s) => s.tasks.length > 0);
  return out;
}

/** The starters, with project files replacing a starter of the same name; by name. */
export function availableTemplates(files: readonly TemplateFile[]): Template[] {
  const byName = new Map(STARTER_TEMPLATES.map((f) => [f.name, f]));
  for (const f of files) if (TemplateName.safeParse(f.name).success) byName.set(f.name, f);
  return [...byName.values()].map(parseTemplate).sort((a, b) => a.name.localeCompare(b.name));
}

export function summarize(t: Template): TemplateSummary {
  return {
    name: t.name,
    title: t.title,
    goal: t.goal,
    source: t.source,
    tasks: t.stages.reduce((n, s) => n + s.tasks.length, 0),
    stages: t.stages.map((s) => ({
      title: s.title,
      offsetDays: s.offsetDays,
      tasks: s.tasks.length,
    })),
  };
}

export function findTemplate(files: readonly TemplateFile[], name: string): Template {
  const all = availableTemplates(files);
  const found = all.find((t) => t.name === name.trim().toLowerCase());
  if (!found) {
    throw new SatiError("NOT_FOUND", `No template named "${name}".`, {
      hint: `Templates here: ${all.map((t) => t.name).join(", ")}. Add your own as .${CLI_NAME}/${TEMPLATE_DIR}/<name>.md.`,
    });
  }
  return found;
}

export const ApplyTemplateInput = z.strictObject({
  template: z.string().trim().min(1).max(60),
  /** The plan's name; default the template's title. */
  title: z.string().trim().min(1).max(LIMITS.title).optional(),
  /** The day it is all for; due dates count from it. Without it, tasks get no due date. */
  targetDate: IsoDay.optional(),
  goal: z.string().trim().max(LIMITS.shortText).optional(),
  dryRun: z.boolean().optional(),
});
export type ApplyTemplateInput = z.input<typeof ApplyTemplateInput>;

export interface PlannedTask {
  title: string;
  stage: string;
  dueDate: string | null;
  checklist: string[];
}

export interface AppliedTemplate {
  template: string;
  /** `null` on a dry run. */
  milestone: Milestone | null;
  title: string;
  targetDate: string | null;
  tasks: PlannedTask[];
  /** Ids of the tasks created, in order; empty on a dry run. */
  taskIds: string[];
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/**
 * Creates a plan from a template, in one transaction: a milestone, and its tasks labelled with
 * the template's labels. Each stage's tasks wait for every task of the stage before, so only the
 * first stage is ready to start; with a target date, each task is due at its stage's offset.
 */
export async function applyTemplate(
  ctx: ServiceContext,
  files: readonly TemplateFile[],
  input: unknown,
): Promise<AppliedTemplate> {
  const data = parseInput(ApplyTemplateInput, input);
  const t = findTemplate(files, data.template);
  const title = data.title ?? t.title;
  const targetDate = data.targetDate ?? null;
  const tasks: PlannedTask[] = t.stages.flatMap((s) =>
    s.tasks.map((task) => ({
      title: task.title,
      stage: s.title,
      dueDate: targetDate && s.offsetDays !== null ? addDays(targetDate, s.offsetDays) : null,
      checklist: task.checklist,
    })),
  );
  if (tasks.length === 0) {
    throw new SatiError("VALIDATION", `Template "${t.name}" has no tasks.`, {
      hint: "Write each task as a line starting with - [ ] under a ## stage heading.",
    });
  }
  if (tasks.length > MAX_TASKS) {
    throw new SatiError("VALIDATION", `Template "${t.name}" has over ${MAX_TASKS} tasks.`, {
      hint: "Split it into several templates.",
    });
  }
  const steps = tasks.find((task) => task.checklist.length > MAX_STEPS);
  if (steps) {
    throw new SatiError("VALIDATION", `"${steps.title}" has over ${MAX_STEPS} checklist steps.`);
  }
  // Checked before the first write, so a refused template leaves nothing behind.
  const milestoneInput = parseInput(CreateMilestoneInput, {
    title,
    goal: data.goal || t.goal,
    targetDate,
  });
  const taskInputs = tasks.map((task) =>
    parseInput(CreateTaskInput, {
      title: task.title,
      labels: t.labels,
      ...(task.dueDate ? { dueDate: task.dueDate } : {}),
      ...(task.checklist.length
        ? { checklist: task.checklist.map((text) => ({ text, done: false })) }
        : {}),
    }),
  );
  refuseSecrets("milestone", milestoneInput);
  for (const input of taskInputs) refuseSecrets("task", input);
  const result = { template: t.name, title, targetDate, tasks };
  // A dry run refuses what the real run would: a secret, or a plan of the same name.
  const refuseSameName = async (r: StorageReader) => {
    const same = (await listAll(r, ctx, "milestone")).find(
      (m) => m.title.toLowerCase() === title.toLowerCase(),
    );
    if (same) {
      // The board shows the message and drops a hint holding a command or id; agents get both.
      throw new SatiError(
        "CONFLICT",
        `A plan named "${same.title}" already exists. Give this one another name.`,
        { hint: `Or add tasks to the existing plan \`${shortHandle(same.id)}\`.` },
      );
    }
  };
  if (data.dryRun) {
    await ctx.store.read(refuseSameName);
    return { ...result, milestone: null, taskIds: [] };
  }

  return ctx.store.write(async (w: StorageWriter) => {
    await refuseSameName(w);
    const milestone = await createMilestoneIn(w, ctx, milestoneInput);
    const created: Task[] = [];
    let previous: string[] = [];
    let next = 0;
    for (const stage of t.stages) {
      const inputs = taskInputs.slice(next, next + stage.tasks.length);
      next += stage.tasks.length;
      const ids: string[] = [];
      for (const input of inputs) {
        const task = await createTaskIn(w, ctx, {
          ...input,
          milestoneId: milestone.id,
          dependsOn: previous,
        });
        created.push(task);
        ids.push(task.id);
      }
      previous = ids;
    }
    return { ...result, milestone, taskIds: created.map((c) => c.id) };
  });
}
