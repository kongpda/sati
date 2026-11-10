import { z } from "zod";
import { type Actor } from "../domain/schemas.js";
import { type ServiceContext } from "./context.js";
import type { ActorIdentity } from "./project.js";
export interface IdentityEnv {
    /** Process environment (only the variables below are read). */
    env: Readonly<Record<string, string | undefined>>;
    /** Absolute path of the current worktree or project root. */
    worktree: string | null;
    /** OS user name, used for humans when `USER` is not set. */
    user?: string | undefined;
}
/**
 * Who is calling (review fix 11). `SATI_ACTOR` wins. Otherwise an agent is
 * `<tool>@<worktree>#<session>` so parallel sessions in different worktrees stay distinct,
 * and a human is `<user>@<worktree>`.
 */
export declare function actorIdentity({ env, worktree, user }: IdentityEnv): ActorIdentity;
/** Each field sets it, `null` clears it back to the default, and a missing field is kept. */
export declare const UpdateProfileInput: z.ZodObject<{
    displayName: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    initials: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    color: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        clay: "clay";
        moss: "moss";
        plum: "plum";
        rose: "rose";
        sky: "sky";
        slate: "slate";
        sun: "sun";
        teal: "teal";
    }>>>;
}, z.core.$strict>;
/**
 * Sets how a person is shown: display name, initials and avatar colour. Only people have a
 * profile, and only a person may change one; agents keep their identity string. No version check:
 * an actor's version moves on every write it makes (its clock stamp), and only people edit this.
 */
export declare function updateProfile(ctx: ServiceContext, actorId: string, input: unknown): Promise<Actor>;
