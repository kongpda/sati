import { z } from "zod";
import { type ServiceContext } from "./context.js";
export declare const CHANGE_KINDS: readonly ["added", "modified", "deleted", "renamed"];
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export declare const DEFAULT_MAX_REMOVAL_RATIO = 0.5;
export declare const CheckChangesInput: z.ZodObject<{
    changes: z.ZodArray<z.ZodObject<{
        path: z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>;
        kind: z.ZodDefault<z.ZodEnum<{
            added: "added";
            deleted: "deleted";
            modified: "modified";
            renamed: "renamed";
        }>>;
        removedLines: z.ZodOptional<z.ZodNumber>;
        baseLines: z.ZodOptional<z.ZodNumber>;
        from: z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>>;
    }, z.core.$strict>>;
    maxRemovalRatio: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type CheckChangesInput = z.input<typeof CheckChangesInput>;
export type GuardVerdict = "ok" | "warn" | "blocked";
export type GuardRule = "locked" | "locked-shared" | "protected-delete" | "protected-gutted" | "shipped-touched" | "renamed-out";
export interface GuardFinding {
    level: Exclude<GuardVerdict, "ok">;
    rule: GuardRule;
    message: string;
    /** Changed paths this finding is about. */
    paths: string[];
    featureId?: string;
    lockId?: string;
    /** A Decision on the feature that lets a removal through. */
    decisionId?: string;
}
export interface GuardResult {
    verdict: GuardVerdict;
    findings: GuardFinding[];
}
/**
 * Checks changed paths against shipped features and other agents' locks. Read-only.
 * - A path inside another actor's exclusive lock is blocked; a shared lock warns.
 * - Deleting a file of a shipped, protected feature, or removing more than `maxRemovalRatio` of
 *   its changed lines, is blocked unless a Decision lists that feature.
 * - Any other change to a shipped feature warns.
 */
export declare function checkChanges(ctx: ServiceContext, input: unknown): Promise<GuardResult>;
/**
 * Writes one `guard` activity row per finding, so warnings and overrides are on record with the
 * actor. `override` marks a run where the caller let a blocked change through (`SATI_GUARD=off`).
 */
export declare function recordGuard(ctx: ServiceContext, result: GuardResult, opts?: {
    override?: boolean;
}): Promise<void>;
