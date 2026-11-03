import { basename } from "node:path";
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
