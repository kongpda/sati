import { z } from "zod";
import type { IdFactory } from "../domain/ids.js";
import { type EntityMap, type StoredEntity, type VERBS } from "../domain/schemas.js";
import type { Clock } from "../ports/clock.js";
import type { ProcessProbe } from "../ports/process.js";
import type { RepoIndex } from "../ports/repo.js";
import type { ListQuery, StorageAdapter, StorageReader, StorageWriter } from "../ports/storage.js";
/** Everything a service call needs. One per command or MCP request. */
export interface ServiceContext {
    store: StorageAdapter;
    clock: Clock;
    ids: IdFactory;
    projectId: string;
    /** Who is acting; written to `createdBy` and to every activity row. */
    actorId: string;
    /** Current git branch, recorded on activity rows. */
    branch: string | null;
    /** The git index, for context-cache hashes. Absent outside a git repo. */
    repo?: RepoIndex;
    /** Whether claim holders still run, so claims of exited agents are released early. */
    processes?: ProcessProbe;
}
export type Verb = (typeof VERBS)[number];
/**
 * Validates untrusted input; failures become VALIDATION errors listing the first issues.
 * Top-level `undefined` values count as absent, so `{ body: undefined }` gets the default body
 * instead of overwriting it (Zod keeps explicit `undefined` keys in its output).
 */
export declare function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T>;
/** Re-validates a full record before it is stored, so services can never write a bad row. */
export declare function checkRecord<E extends StoredEntity>(entity: E, value: unknown): EntityMap[E];
export declare const nowIso: (ctx: Pick<ServiceContext, "clock">) => string;
/** Drops keys whose value is `undefined`, so a patch never erases a field by accident. */
export declare function defined<T extends object>(patch: T): Partial<T>;
export declare function baseFields(ctx: ServiceContext, entity: StoredEntity): {
    id: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
    createdBy: string;
    version: number;
    deletedAt: null;
};
/** Every undeleted record of one entity in this project, paging past the list limit. */
export declare function listAll<E extends StoredEntity>(r: StorageReader, ctx: ServiceContext, entity: E, opts?: Pick<ListQuery, "includeDeleted" | "handoff" | "status" | "path">): Promise<EntityMap[E][]>;
/**
 * How an actor this machine does not know is named. Actors stay on their machine, but a task's
 * claim travels in `.sati/`, so a teammate's claim names an actor that is not here.
 */
export declare const UNKNOWN_ACTOR = "another machine";
/** An actor's display name, or UNKNOWN_ACTOR. */
export declare function actorName(r: StorageReader, actorId: string): Promise<string>;
/** A live (not deleted) record of this project, or NOT_FOUND. */
export declare function mustGet<E extends StoredEntity>(r: StorageReader, ctx: Pick<ServiceContext, "projectId">, entity: E, id: string): Promise<EntityMap[E]>;
/** True for the placeholder `changes` stores in place of long text; the original is gone. */
export declare const isCompacted: (v: unknown) => boolean;
/** Field-level diff for the activity log. Long text is replaced by its length. */
export declare function changes(before: object, after: object): Record<string, unknown>;
export declare function logActivity(w: StorageWriter, ctx: ServiceContext, verb: Verb, entity: StoredEntity, entityId: string, diff: Record<string, unknown>): Promise<void>;
/** Inserts a validated record and its `create` activity row. Call inside `store.write`. */
export declare function insertWithLog<E extends StoredEntity>(w: StorageWriter, ctx: ServiceContext, entity: E, value: unknown, verb?: Verb): Promise<EntityMap[E]>;
/**
 * Applies `patch`, bumps the version and logs the diff. A patch that changes nothing writes
 * nothing. `expectedVersion` lets callers detect edits made since they last read.
 */
export declare function updateWithLog<E extends StoredEntity>(w: StorageWriter, ctx: ServiceContext, entity: E, before: EntityMap[E], patch: object, opts?: {
    verb?: Verb;
    expectedVersion?: number | undefined;
    clear?: readonly string[];
}): Promise<EntityMap[E]>;
/** Rejects a status change the entity's state machine does not allow. */
export declare function assertTransition<S extends string>(machine: Readonly<Record<S, readonly S[]>>, entity: StoredEntity, from: S, to: S): void;
export declare const ExpectedVersion: {
    expectedVersion: z.ZodOptional<z.ZodNumber>;
};
