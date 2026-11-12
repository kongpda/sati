import {
  type AppliedTemplate,
  applyTemplate,
  availableTemplates,
  CLI_NAME,
  findTemplate,
  shortHandle,
  summarize,
  type TemplateSummary,
} from "@sati/core";
import { defineCommand } from "citty";
import { json } from "../args.js";
import { execute } from "../runtime/output.js";
import { readTemplateFiles } from "../templates.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const list = defineCommand({
  meta: { name: "list", description: "List the templates: the starters and .sati/templates/" },
  args: { ...json },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ location }) => availableTemplates(readTemplateFiles(location.root)).map(summarize),
      (items: TemplateSummary[]) =>
        items
          .map(
            (t) =>
              `${t.name.padEnd(16)} ${t.title} (${plural(t.tasks, "task")} in ${plural(t.stages.length, "stage")}${t.source === "built-in" ? "" : `, ${t.source}`})`,
          )
          .join("\n"),
    ),
});

const show = defineCommand({
  meta: { name: "show", description: "Print a template's Markdown, to copy and edit" },
  args: {
    name: { type: "positional", required: true, description: "Template name" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ location }) => {
        const t = findTemplate(readTemplateFiles(location.root), args.name);
        return { ...summarize(t), markdown: t.markdown };
      },
      (t: TemplateSummary & { markdown: string }) => t.markdown.trimEnd(),
    ),
});

const apply = defineCommand({
  meta: { name: "apply", description: "Create a plan (milestone and tasks) from a template" },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "A starter (see `template list`) or one of yours",
    },
    title: { type: "string", description: "The plan's name (default: the template's)" },
    date: { type: "string", description: "Target day, YYYY-MM-DD; due dates count back from it" },
    goal: { type: "string", description: "The plan's goal (default: the template's)" },
    "dry-run": { type: "boolean", description: "Show the tasks without creating anything" },
    ...json,
  },
  run: ({ args }) =>
    execute(
      args.json,
      async ({ ctx, location }) =>
        applyTemplate(ctx, readTemplateFiles(location.root), {
          template: args.name,
          title: args.title,
          targetDate: args.date,
          goal: args.goal,
          dryRun: args["dry-run"],
        }),
      (a: AppliedTemplate) => {
        const stages: string[] = [];
        let stage = "";
        for (const t of a.tasks) {
          if (t.stage !== stage) {
            stage = t.stage;
            stages.push(`${stage}:`);
          }
          const due = t.dueDate ? ` (due ${t.dueDate})` : "";
          const steps = t.checklist.length ? `, ${t.checklist.length} steps` : "";
          stages.push(`- ${t.title}${due}${steps}`);
        }
        const head = a.milestone
          ? `Created ${shortHandle(a.milestone.id)} ${a.title} with ${plural(a.tasks.length, "task")}.`
          : `Would create ${a.title} with ${plural(a.tasks.length, "task")} (dry run, nothing written).`;
        const today = new Date().toISOString().slice(0, 10);
        const late = a.tasks.filter((t) => t.dueDate !== null && t.dueDate < today).length;
        const warn = late
          ? `\nNote: ${plural(late, "task")} ${late === 1 ? "is" : "are"} already past due; pick a later --date or move them.`
          : "";
        const next = a.milestone
          ? `\nEach stage waits for the one before. Start with \`${CLI_NAME} task list --milestone ${shortHandle(a.milestone.id)} --ready\`.`
          : "";
        return `${head}\n${stages.join("\n")}${next}${warn}`;
      },
    ),
});

export default defineCommand({
  meta: {
    name: "template",
    description: "Start a plan from a template (event, campaign, proposal, monthly-report, ...)",
  },
  subCommands: { list, show, apply },
});
