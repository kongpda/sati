import { z } from "zod";
import { type Lock } from "../domain/schemas.js";
import type { StorageReader, StorageWriter } from "../ports/storage.js";
import { type ServiceContext } from "./context.js";
export declare const AcquireLockInput: z.ZodObject<{
    paths: z.ZodArray<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
    mode: z.ZodDefault<z.ZodEnum<{
        exclusive: "exclusive";
        shared: "shared";
    }>>;
    taskId: z.ZodOptional<z.ZodString>;
    reason: z.ZodDefault<z.ZodString>;
    leaseMinutes: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export declare const ReleaseLockInput: z.ZodObject<{
    force: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type AcquireLockInput = z.input<typeof AcquireLockInput>;
export type ReleaseLockInput = z.input<typeof ReleaseLockInput>;
/** Another agent's live lock that overlaps the requested paths. */
export interface LockOverlap {
    lockId: string;
    actorId: string;
    holderName: string;
    mode: Lock["mode"];
    leaseUntil: string;
    /** `[requested, held]` path pairs that overlap. */
    paths: [string, string][];
}
export interface AcquireLockResult {
    lock: Lock;
    /** Overlaps with other agents' shared locks: allowed, but worth knowing about. */
    warnings: LockOverlap[];
}
export declare const isLive: (l: Pick<Lock, "leaseUntil">, now: string) => boolean;
/** Other actors' live locks. */
export declare function othersLiveLocks(r: StorageReader, ctx: ServiceContext): Promise<Lock[]>;
/** Live locks, oldest first. Expired locks are not listed; they no longer block anyone. */
export declare function listLocks(ctx: ServiceContext): Promise<Lock[]>;
/**
 * Locks paths for the calling actor. The check and the insert run in one write transaction, so
 * two agents can never both hold overlapping exclusive locks. An overlap with another actor's
 * live lock fails with CONFLICT when either side is exclusive; shared over shared is allowed and
 * returned as a warning. The caller's own locks never conflict. Expired locks are released first.
 */
export declare function acquireLock(ctx: ServiceContext, input: unknown): Promise<AcquireLockResult>;
/**
 * Releases a lock. Only the holder may release a live lock unless `force` is set; a forced
 * release is logged with the releasing actor, like every write. Expired locks anyone may release.
 */
export declare function releaseLock(ctx: ServiceContext, id: string, input?: unknown): Promise<Lock>;
/**
 * Releases the locks `holder` (default: the caller) holds for a task. Call inside `store.write`.
 * The release is logged with the caller, so a person releasing an agent's claim is recorded.
 */
export declare function releaseTaskLocks(w: StorageWriter, ctx: ServiceContext, taskId: string, holder?: string): Promise<Lock[]>;
/**
 * Moves the lease of the caller's live locks for a task out to `leaseUntil`, so a lock does not
 * lapse while the claim it serves is renewed. Call inside `store.write`. Expired locks are left
 * alone: another agent may already hold those paths.
 */
export declare function renewTaskLocks(w: StorageWriter, ctx: ServiceContext, taskId: string, leaseUntil: string): Promise<void>;
