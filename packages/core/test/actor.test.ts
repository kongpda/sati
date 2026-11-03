import { describe, expect, it } from "vitest";
import { actorIdentity } from "../src/index.js";

const wt = "/repo/.worktrees/feature-a";

// The identity name is the actor's key: two sessions must differ, and the same session must
// map back to the same actor every time it runs a command.
describe("actorIdentity", () => {
  it("BRAIN_ACTOR overrides everything", () => {
    const id = actorIdentity({ env: { BRAIN_ACTOR: "ci-bot", CLAUDECODE: "1" }, worktree: wt });
    expect(id).toEqual({ name: "ci-bot", kind: "agent", tool: "claude-code", worktree: wt });
  });

  it("names a Claude Code session by tool, worktree and session id", () => {
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "a8a4c547-6dd2-43ae" };
    expect(actorIdentity({ env, worktree: wt }).name).toBe("claude-code@feature-a#a8a4c547");
  });

  it("keeps parallel sessions in one worktree distinct", () => {
    const a = actorIdentity({
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "11111111" },
      worktree: wt,
    });
    const b = actorIdentity({
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "22222222" },
      worktree: wt,
    });
    expect(a.name).not.toBe(b.name);
  });

  it("falls back to the AI_AGENT prefix for other tools", () => {
    const id = actorIdentity({ env: { AI_AGENT: "Codex_1-0_agent" }, worktree: "/x/main" });
    expect(id).toMatchObject({ name: "codex@main", kind: "agent", tool: "codex" });
  });

  it("treats a caller with no agent markers as a human", () => {
    const id = actorIdentity({ env: { USER: "dara" }, worktree: "/x/main" });
    expect(id).toEqual({ name: "dara@main", kind: "human", tool: null, worktree: "/x/main" });
    expect(actorIdentity({ env: {}, worktree: null, user: "os" }).name).toBe("os@local");
  });
});
