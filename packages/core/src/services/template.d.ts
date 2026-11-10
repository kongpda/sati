import { z } from "zod";
import { type Milestone } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
/** Where a project keeps its own templates, inside its `.sati/` folder. */
export declare const TEMPLATE_DIR = "templates";
/** A template file larger than this is not read. */
export declare const TEMPLATE_MAX_BYTES = 200000;
export declare const TemplateName: z.ZodString;
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
    tasks: {
        title: string;
        checklist: string[];
    }[];
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
    stages: {
        title: string;
        offsetDays: number | null;
        tasks: number;
    }[];
}
export declare const STARTER_TEMPLATES: readonly TemplateFile[];
/**
 * Reads a template: `# Name`, optional `Goal:` and `Labels:` lines, then `## Stage (-6w)`
 * headings with `- [ ] task` lines; an indented `- [ ]` under a task is a step of its
 * checklist. Tasks before the first stage form a stage of their own. Anything else is ignored,
 * so a template can carry notes for the person editing it.
 */
export declare function parseTemplate(file: TemplateFile): Template;
/** The starters, with project files replacing a starter of the same name; by name. */
export declare function availableTemplates(files: readonly TemplateFile[]): Template[];
export declare function summarize(t: Template): TemplateSummary;
export declare function findTemplate(files: readonly TemplateFile[], name: string): Template;
export declare const ApplyTemplateInput: z.ZodObject<{
    template: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    targetDate: z.ZodOptional<z.ZodString>;
    goal: z.ZodOptional<z.ZodString>;
    dryRun: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
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
/**
 * Creates a plan from a template, in one transaction: a milestone, and its tasks labelled with
 * the template's labels. Each stage's tasks wait for every task of the stage before, so only the
 * first stage is ready to start; with a target date, each task is due at its stage's offset.
 */
export declare function applyTemplate(ctx: ServiceContext, files: readonly TemplateFile[], input: unknown): Promise<AppliedTemplate>;
