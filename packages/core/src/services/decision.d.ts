import type { z } from "zod";
import { Decision } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
export declare const RecordDecisionInput: z.ZodObject<{
    title: z.ZodString;
    supersedes: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    featureIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    context: z.ZodOptional<z.ZodString>;
    decision: z.ZodString;
    consequences: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type RecordDecisionInput = z.input<typeof RecordDecisionInput>;
/** Decisions are append-only: to change one, record a new one that `supersedes` it. */
export declare function recordDecision(ctx: ServiceContext, input: unknown): Promise<Decision>;
