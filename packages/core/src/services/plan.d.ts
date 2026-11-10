import { z } from "zod";
import { type ServiceContext } from "./context.js";
export declare const ImportPlanInput: z.ZodObject<{
    markdown: z.ZodString;
    dryRun: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export interface PlanChange {
    kind: "milestone" | "task";
    title: string;
    key: string;
}
export interface PlanImport {
    added: PlanChange[];
    skipped: PlanChange[];
}
/** Most tasks and milestones one import may add, so a pasted file cannot flood the project. */
export declare const PLAN_MAX_TASKS = 500;
export declare const PLAN_MAX_MILESTONES = 100;
interface Item {
    heading: string;
    line: number;
    title: string;
    key: string;
}
/** One milestone per heading, one task per unchecked box in it. The key is heading plus item text. */
export declare function parsePlan(markdown: string): Item[];
/**
 * Adds milestones and tasks from a Markdown list. Re-running matches the stable key and
 * adds only what is new. It never deletes and never writes the file.
 */
export declare function importPlan(ctx: ServiceContext, input: unknown): Promise<PlanImport>;
export {};
