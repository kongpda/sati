import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  availableTemplates,
  listRecords,
  listTasks,
  parseTemplate,
  STARTER_TEMPLATES,
  summarize,
  type TemplateFile,
} from "../src/index.js";
import { setup } from "./support/setup.js";

const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

const file = (name: string, markdown: string): TemplateFile => ({
  name,
  markdown,
  source: `.sati/templates/${name}.md`,
});

describe("applyTemplate", () => {
  it("creates a plan whose stages wait for each other and count back from the day", async () => {
    const { ctx } = await setup();
    const applied = await applyTemplate(ctx, [], {
      template: "event",
      title: "Spring fair",
      targetDate: "2026-12-20",
    });
    const plan = applied.milestone;
    expect(plan).toMatchObject({ title: "Spring fair", targetDate: "2026-12-20" });
    expect(plan?.goal).toContain("on budget");

    const tasks = await listTasks(ctx, { milestoneId: plan?.id, limit: 500 });
    expect(tasks).toHaveLength(18);
    expect(new Set(tasks.flatMap((t) => t.labels))).toEqual(new Set(["event"]));
    const byTitle = new Map(tasks.map((t) => [t.title, t]));
    const plan1 = ["Set the date, budget and goal", "Draft the guest list", "Choose the venue"];
    // Eight weeks before, and one week after.
    expect(byTitle.get("Draft the guest list")?.dueDate).toBe("2026-10-25");
    expect(byTitle.get("Send thank-you notes")?.dueDate).toBe("2026-12-27");
    expect(byTitle.get("Welcome guests and run the agenda")?.dueDate).toBe("2026-12-20");
    expect(byTitle.get("Choose the venue")?.checklist).toEqual([
      { text: "Shortlist three venues", done: false },
      { text: "Visit or call each one", done: false },
      { text: "Compare price, size and access", done: false },
    ]);
    // A stage waits for all of the stage before, and only for it.
    const firstIds = plan1.map((t) => byTitle.get(t)?.id).sort();
    expect([...(byTitle.get("Book catering")?.dependsOn ?? [])].sort()).toEqual(firstIds);
    expect(byTitle.get("Send the invitations")?.dependsOn).toHaveLength(3);
    expect(byTitle.get("Draft the guest list")?.dependsOn).toEqual([]);
    const ready = await listTasks(ctx, { ready: true, limit: 500 });
    expect(ready.map((t) => t.title).sort()).toEqual([...plan1].sort());
    expect(applied.taskIds).toHaveLength(18);
  });

  it("gives no due dates without a day, and refuses a second plan of the same name", async () => {
    const { ctx } = await setup();
    const applied = await applyTemplate(ctx, [], { template: "release" });
    expect(applied.milestone?.title).toBe("Product release");
    const tasks = await listTasks(ctx, { milestoneId: applied.milestone?.id, limit: 500 });
    expect(tasks).toHaveLength(18);
    expect(tasks.every((t) => t.dueDate === undefined)).toBe(true);
    expect(await code(() => applyTemplate(ctx, [], { template: "release" }))).toBe("CONFLICT");
    expect(
      await code(() => applyTemplate(ctx, [], { template: "event", title: "product RELEASE" })),
    ).toBe("CONFLICT");
    expect(await listRecords(ctx, "milestone", {})).toHaveLength(1);
    expect(await listTasks(ctx, { limit: 500 })).toHaveLength(18);
  });

  it("writes nothing on a dry run, or when one task is refused", async () => {
    const { ctx } = await setup();
    const dry = await applyTemplate(ctx, [], {
      template: "campaign",
      targetDate: "2026-12-01",
      dryRun: true,
    });
    expect(dry.milestone).toBeNull();
    expect(dry.tasks[0]).toEqual({
      title: "Write the brief: audience, message, goal and budget",
      stage: "Brief",
      dueDate: "2026-10-20",
      checklist: [],
    });
    // The preview must refuse what the real run refuses: a taken name, and a secret.
    await applyTemplate(ctx, [], { template: "campaign", title: "Spring" });
    const again = { template: "campaign", title: "spring", dryRun: true };
    expect(await code(() => applyTemplate(ctx, [], again))).toBe("CONFLICT");
    const key = `gh${"p_"}${"a1".repeat(18)}`;
    const leaky = file("leaky", `## A\n- [ ] deploy with ${key}\n`);
    expect(await code(() => applyTemplate(ctx, [leaky], { template: "leaky", dryRun: true }))).toBe(
      "VALIDATION",
    );
    const long = file("long", `## A\n- [ ] ok\n- [ ] ${"x".repeat(400)}\n`);
    expect(await code(() => applyTemplate(ctx, [long], { template: "long" }))).toBe("VALIDATION");
    const empty = file("empty", "# Nothing here\n\nJust prose.\n");
    expect(await code(() => applyTemplate(ctx, [empty], { template: "empty" }))).toBe("VALIDATION");
    expect(await code(() => applyTemplate(ctx, [], { template: "wedding" }))).toBe("NOT_FOUND");
    expect(await listRecords(ctx, "milestone", {})).toHaveLength(1);
  });
});

describe("templates", () => {
  // A starter is what an office user sees first. A stage without an offset gives its tasks no
  // due date, and a missing day-0 stage leaves the plan's own date without a task.
  it("ships starters whose every stage counts from the plan's day", () => {
    for (const file of STARTER_TEMPLATES) {
      const t = parseTemplate(file);
      expect(t.goal, file.name).not.toBe("");
      expect(t.stages.length, file.name).toBeGreaterThan(1);
      expect(
        t.stages.every((s) => s.offsetDays !== null && s.tasks.length > 0),
        file.name,
      ).toBe(true);
      expect(
        t.stages.some((s) => s.offsetDays === 0),
        file.name,
      ).toBe(true);
    }
  });

  it("reads stages, offsets, steps and notes, and lets a project file replace a starter", () => {
    const own = file(
      "event",
      [
        "# Team offsite",
        "Goal: Two days away.",
        "Labels: offsite, people",
        "",
        "Notes for whoever edits this are ignored.",
        "- [ ] Pick dates",
        "",
        "## Travel (-10d)",
        "- [ ] Book the bus",
        "  - [ ] Ask for quotes",
        "* [ ] Collect dietary needs",
        "- [x] Already done items are not tasks",
        "## Empty stage (-2d)",
        "## After (+3d)",
        "- [ ] Share photos",
      ].join("\n"),
    );
    const t = parseTemplate(own);
    expect(t).toMatchObject({
      title: "Team offsite",
      goal: "Two days away.",
      markdown: own.markdown,
    });
    expect(t.labels).toEqual(["offsite", "people"]);
    expect(t.stages).toEqual([
      { title: "Start", offsetDays: null, tasks: [{ title: "Pick dates", checklist: [] }] },
      {
        title: "Travel",
        offsetDays: -10,
        tasks: [
          { title: "Book the bus", checklist: ["Ask for quotes"] },
          { title: "Collect dietary needs", checklist: [] },
        ],
      },
      { title: "After", offsetDays: 3, tasks: [{ title: "Share photos", checklist: [] }] },
    ]);

    const all = availableTemplates([own, file("Bad Name", "- [ ] x"), file("trip", "- [ ] Go")]);
    expect(all.map((x) => [x.name, x.source])).toEqual([
      ["campaign", "built-in"],
      ["content-calendar", "built-in"],
      ["event", ".sati/templates/event.md"],
      ["meeting-notes", "built-in"],
      ["monthly-report", "built-in"],
      ["proposal", "built-in"],
      ["release", "built-in"],
      ["trip", ".sati/templates/trip.md"],
    ]);
    expect(summarize(t)).toMatchObject({ tasks: 4, stages: [{ tasks: 1 }, { tasks: 2 }, {}] });
  });
});
