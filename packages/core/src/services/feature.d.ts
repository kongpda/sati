import { z } from "zod";
import { Feature } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
export declare const CreateFeatureInput: z.ZodObject<{
    title: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<{
        building: "building";
        deprecated: "deprecated";
        planned: "planned";
        removed: "removed";
        shipped: "shipped";
    }>>;
    protected: z.ZodOptional<z.ZodBoolean>;
    acceptance: z.ZodOptional<z.ZodArray<z.ZodString>>;
    milestoneId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    description: z.ZodOptional<z.ZodString>;
    paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tests: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$strict>;
export declare const UpdateFeatureInput: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<{
        building: "building";
        deprecated: "deprecated";
        planned: "planned";
        removed: "removed";
        shipped: "shipped";
    }>>;
    protected: z.ZodOptional<z.ZodBoolean>;
    acceptance: z.ZodOptional<z.ZodArray<z.ZodString>>;
    milestoneId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    expectedVersion: z.ZodOptional<z.ZodNumber>;
    description: z.ZodOptional<z.ZodString>;
    paths: z.ZodOptional<z.ZodArray<z.ZodString>>;
    tests: z.ZodOptional<z.ZodArray<z.ZodString>>;
    decisionId: z.ZodOptional<z.ZodString>;
    reviewed: z.ZodOptional<z.ZodLiteral<true>>;
}, z.core.$strict>;
export type CreateFeatureInput = z.input<typeof CreateFeatureInput>;
export type UpdateFeatureInput = z.input<typeof UpdateFeatureInput>;
export declare function createFeature(ctx: ServiceContext, input: unknown): Promise<Feature>;
/**
 * Updates a feature. Removing a shipped or deprecated feature needs `decisionId`: a Decision
 * that lists this feature, so the reason for the removal is on record.
 */
export declare function updateFeature(ctx: ServiceContext, id: string, input: unknown): Promise<Feature>;
