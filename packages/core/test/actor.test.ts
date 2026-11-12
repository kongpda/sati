import { describe, expect, it } from "vitest";
import { actorIdentity, ensureActor, updateProfile } from "../src/index.js";
import { setup } from "./support/setup.js";

const wt = "/repo/.worktrees/feature-a";

// The identity name is the actor's key: two sessions must differ, and the same session must
// map back to the same actor every time it runs a command.
describe("actorIdentity", () => {
  it("SATI_ACTOR overrides everything", () => {
    const id = actorIdentity({ env: { SATI_ACTOR: "ci-bot", CLAUDECODE: "1" }, worktree: wt });
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

  // Claude Desktop and Cowork set no agent variable. Recorded as a person, an agent could
  // approve its own work and pass every check meant for people.
  it("treats an MCP caller as an agent named after its client", () => {
    const id = actorIdentity({ env: { USER: "dara" }, worktree: wt, mcpClient: "Claude Desktop" });
    expect(id).toMatchObject({
      name: "claude-desktop@feature-a",
      kind: "agent",
      tool: "claude-desktop",
    });
    // Before the client says its name, the caller is still an agent.
    expect(actorIdentity({ env: {}, worktree: wt, mcpClient: "" })).toMatchObject({
      kind: "agent",
      tool: "mcp",
    });
    // A tool named by the environment carries the session id, so it wins.
    const known = actorIdentity({ env: { CLAUDECODE: "1" }, worktree: wt, mcpClient: "x" });
    expect(known.tool).toBe("claude-code");
  });
});

describe("updateProfile", () => {
  it("lets a person set and clear how people are shown, and logs it", async () => {
    const { ctx, store, actor: agent } = await setup();
    const kong = await ensureActor(ctx, {
      name: "kong@main",
      kind: "human",
      tool: null,
      worktree: null,
    });
    const asKong = { ...ctx, actorId: kong.id };
    const before = store.activity.length;
    const set = await updateProfile(asKong, kong.id, {
      displayName: "  Kong Da ",
      initials: "KD",
      color: "plum",
    });
    expect(set).toMatchObject({
      name: "kong@main",
      displayName: "Kong Da",
      initials: "KD",
      color: "plum",
    });
    expect(store.activity.slice(before)).toEqual([
      expect.objectContaining({ verb: "update", entity: "actor", entityId: kong.id }),
    ]);
    // null goes back to the default; a field left out is kept.
    const cleared = await updateProfile(asKong, kong.id, { initials: null });
    expect(Object.keys(cleared)).not.toContain("initials");
    expect(cleared.displayName).toBe("Kong Da");

    // Agents neither have a profile nor change one.
    await expect(updateProfile(asKong, agent.id, { displayName: "Bot" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    await expect(updateProfile(ctx, kong.id, { displayName: "Hacked" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    await expect(updateProfile(asKong, kong.id, { color: "neon" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(updateProfile(asKong, kong.id, { displayName: "   " })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});
