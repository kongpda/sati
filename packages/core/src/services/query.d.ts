import { z } from "zod";
import type { EntityMap, StoredEntity } from "../domain/schemas.js";
import { type SearchHit } from "../ports/storage.js";
import { type ServiceContext } from "./context.js";
export declare function listInput(entity: StoredEntity): z.ZodObject<{
    status: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        [x: string]: string;
    }> | z.ZodNever>>;
    featureId: z.ZodOptional<z.ZodString>;
    milestoneId: z.ZodOptional<z.ZodString>;
    parentId: z.ZodOptional<z.ZodString>;
    label: z.ZodOptional<z.ZodString>;
    includeDeleted: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare function getRecord<E extends StoredEntity>(ctx: ServiceContext, entity: E, recordId: string): Promise<EntityMap[E]>;
export declare function listRecords<E extends StoredEntity>(ctx: ServiceContext, entity: E, input?: unknown): Promise<EntityMap[E][]>;
/**
 * Turns a full ID or a short handle (`tsk_8f3k2a`) into a full ID of this project.
 * A handle matching several records fails with AMBIGUOUS and lists them.
 */
export declare function resolveId(ctx: ServiceContext, entity: StoredEntity, ref: string, 
/** Match only deleted records, for restore. */
opts?: {
    deleted?: boolean;
}): Promise<string>;
export declare const SearchInput: z.ZodObject<{
    query: z.ZodString;
    entities: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        context: "context";
        decision: "decision";
        feature: "feature";
        note: "note";
        task: "task";
    }>>>;
    limit: z.ZodOptional<z.ZodNumber>;
    match: z.ZodOptional<z.ZodEnum<{
        all: "all";
        any: "any";
    }>>;
}, z.core.$strict>;
export type SearchInput = z.input<typeof SearchInput>;
/** Full-text search across tasks, features, notes and decisions of this project. */
export declare function search(ctx: ServiceContext, input: unknown): Promise<SearchHit[]>;
