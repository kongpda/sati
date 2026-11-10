import type { z } from "zod";
import { Milestone } from "../domain/schemas.js";
import type { StorageWriter } from "../ports/storage.js";
import { type ServiceContext } from "./context.js";
export declare const CreateMilestoneInput: z.ZodObject<{
    title: z.ZodString;
    goal: z.ZodOptional<z.ZodString>;
    targetDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodOptional<z.ZodEnum<{
        active: "active";
        done: "done";
        planned: "planned";
    }>>;
    order: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const UpdateMilestoneInput: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    goal: z.ZodOptional<z.ZodString>;
    targetDate: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodOptional<z.ZodEnum<{
        active: "active";
        done: "done";
        planned: "planned";
    }>>;
    order: z.ZodOptional<z.ZodNumber>;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare function createMilestone(ctx: ServiceContext, input: unknown): Promise<Milestone>;
/** `createMilestone` inside a caller's transaction. */
export declare function createMilestoneIn(w: StorageWriter, ctx: ServiceContext, data: z.output<typeof CreateMilestoneInput>): Promise<Milestone>;
export declare function updateMilestone(ctx: ServiceContext, id: string, input: unknown): Promise<Milestone>;
export type CreateMilestoneInput = z.input<typeof CreateMilestoneInput>;
