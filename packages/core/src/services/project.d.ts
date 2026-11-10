import { z } from "zod";
import type { IdFactory } from "../domain/ids.js";
import { type Actor, type Project, ProjectKind, type ProjectSettings } from "../domain/schemas.js";
import type { Clock } from "../ports/clock.js";
import type { StorageAdapter } from "../ports/storage.js";
import { type ServiceContext } from "./context.js";
export declare const DEFAULT_LEASE_MINUTES = 30;
export declare const ActorIdentityInput: z.ZodObject<{
    name: z.ZodString;
    kind: z.ZodEnum<{
        agent: "agent";
        human: "human";
    }>;
    tool: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    worktree: z.ZodDefault<z.ZodNullable<z.ZodString>>;
}, z.core.$strict>;
export type ActorIdentity = z.input<typeof ActorIdentityInput>;
export declare const InitProjectInput: z.ZodObject<{
    slug: z.ZodString;
    name: z.ZodString;
    repoUrl: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    mode: z.ZodDefault<z.ZodEnum<{
        git: "git";
        standalone: "standalone";
        stealth: "stealth";
    }>>;
    kind: z.ZodDefault<z.ZodEnum<{
        code: "code";
        general: "general";
    }>>;
    leaseMinutes: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
export type InitProjectInput = z.input<typeof InitProjectInput>;
/** Settings as stored, including rows written before review, autoContinue and kind existed. */
export declare function readSettings(raw: Partial<ProjectSettings> | undefined): ProjectSettings & {
    kind: ProjectKind;
};
export declare const UpdateSettingsInput: z.ZodObject<{
    leaseMinutes: z.ZodOptional<z.ZodNumber>;
    review: z.ZodOptional<z.ZodEnum<{
        agents: "agents";
        all: "all";
        none: "none";
    }>>;
    autoContinue: z.ZodOptional<z.ZodBoolean>;
    kind: z.ZodOptional<z.ZodEnum<{
        code: "code";
        general: "general";
    }>>;
}, z.core.$strict>;
export type UpdateSettingsInput = z.input<typeof UpdateSettingsInput>;
/** Changes project settings. Missing fields keep their current value. */
export declare function updateSettings(ctx: ServiceContext, input: unknown): Promise<Project>;
interface Deps {
    store: StorageAdapter;
    clock: Clock;
    ids: IdFactory;
    branch?: string | null;
}
/** Creates the one project in this DB, its first actor, and an `init` activity row. */
export declare function initProject(deps: Deps, input: InitProjectInput, identity: ActorIdentity): Promise<{
    project: Project;
    actor: Actor;
}>;
export declare function getProject(store: StorageAdapter): Promise<Project>;
/**
 * Returns the actor with this identity, creating it (and its activity row) on first use.
 * Identity names are unique per project, so a returning agent keeps its ID.
 */
export declare function ensureActor(deps: Deps & {
    projectId: string;
}, identity: ActorIdentity): Promise<Actor>;
export {};
