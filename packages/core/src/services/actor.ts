import { basename } from "node:path";
import { z } from "zod";
import { SatiError } from "../domain/errors.js";
import { type Actor, Actor as ActorSchema } from "../domain/schemas.js";
import { mustGet, parseInput, type ServiceContext, updateWithLog } from "./context.js";
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
 * Detects the agent tool from its environment. Only Claude Code is verified; the generic
 * `AI_AGENT` variable (e.g. `claude-code_2-1-309_agent`) covers tools that set it.
 */
function detectTool(env: IdentityEnv["env"]): string | null {
  if (env.CLAUDECODE === "1") return "claude-code";
  const agent = env.AI_AGENT?.trim();
  if (agent) return agent.split("_")[0]?.toLowerCase() || null;
  return null;
}

function sessionId(env: IdentityEnv["env"]): string | null {
  const raw = env.CLAUDE_CODE_SESSION_ID ?? env.SATI_SESSION_ID;
  return raw ? raw.replace(/[^0-9a-z]/gi, "").slice(0, 8) || null : null;
}

/**
 * Who is calling (review fix 11). `SATI_ACTOR` wins. Otherwise an agent is
 * `<tool>@<worktree>#<session>` so parallel sessions in different worktrees stay distinct,
 * and a human is `<user>@<worktree>`.
 */
export function actorIdentity({ env, worktree, user }: IdentityEnv): ActorIdentity {
  const tool = detectTool(env);
  const kind = tool ? "agent" : "human";
  const forced = env.SATI_ACTOR?.trim();
  if (forced) return { name: forced, kind, tool, worktree };
  const place = worktree ? basename(worktree) : "local";
  if (tool) {
    const session = sessionId(env);
    return { name: `${tool}@${place}${session ? `#${session}` : ""}`, kind, tool, worktree };
  }
  const who = env.USER ?? env.USERNAME ?? user ?? "human";
  return { name: `${who}@${place}`, kind, tool: null, worktree };
}

const profile = ActorSchema.pick({ displayName: true, initials: true, color: true }).shape;
/** Each field sets it, `null` clears it back to the default, and a missing field is kept. */
export const UpdateProfileInput = z.strictObject({
  displayName: profile.displayName.unwrap().nullable().optional(),
  initials: profile.initials.unwrap().nullable().optional(),
  color: profile.color.unwrap().nullable().optional(),
});
export type UpdateProfileInput = z.input<typeof UpdateProfileInput>;

/**
 * Sets how a person is shown: display name, initials and avatar colour. Only people have a
 * profile, and only a person may change one; agents keep their identity string. No version check:
 * an actor's version moves on every write it makes (its clock stamp), and only people edit this.
 */
export async function updateProfile(
  ctx: ServiceContext,
  actorId: string,
  input: unknown,
): Promise<Actor> {
  const data = parseInput(UpdateProfileInput, input);
  return ctx.store.write(async (w) => {
    const caller = await mustGet(w, ctx, "actor", ctx.actorId);
    if (caller.kind !== "human") {
      throw new SatiError("VALIDATION", "Only a person can change how people are shown.");
    }
    const before = await mustGet(w, ctx, "actor", actorId);
    if (before.kind !== "human") {
      throw new SatiError("VALIDATION", "Agents have no profile; they are shown by their name.");
    }
    const keys = ["displayName", "initials", "color"] as const;
    const set = Object.fromEntries(keys.flatMap((k) => (data[k] ? [[k, data[k]]] : [])));
    const clear = keys.filter((k) => data[k] === null && before[k] !== undefined);
    return updateWithLog(w, ctx, "actor", before, set, { clear });
  });
}
