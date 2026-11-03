import { describe, expect, it } from "vitest";
import {
  BRIEF_TOKEN_CAP,
  buildBrief,
  claimTask,
  createFeature,
  createTask,
  ensureActor,
  estimateTokens,
  recordDecision,
  shortHandle,
} from "../src/index.js";
import { setup } from "./support/setup.js";

describe("buildBrief", () => {
  it("shows my claimed task with its feature's acceptance criteria, ready work and context", async () => {
    const { ctx, clock, actor } = await setup();
    const old = await recordDecision(ctx, { title: "Old call", decision: "x" });
    clock.advance(8 * 24 * 60 * 60 * 1000);
    const feat = await createFeature(ctx, {
      title: "Login",
      protected: true,
      status: "building",
      paths: ["src/login/**"],
      acceptance: ["Wrong password shows an error", "Session survives reload"],
    });
    const mine = await createTask(ctx, { title: "Login form", featureId: feat.id });
    await claimTask(ctx, mine.id);
    const next = await createTask(ctx, { title: "Logout button", priority: "high" });
    const recent = await recordDecision(ctx, { title: "Use cookies", decision: "y" });

    const brief = await buildBrief(ctx);
    const md = brief.markdown;
    expect(md).toContain(`You are claude-code@main#1 (${shortHandle(actor.id)})`);
    // My task carries its acceptance criteria so the agent knows what "done" means.
    expect(md).toContain(`${shortHandle(mine.id)} [in_progress, medium] Login form`);
    expect(md).toContain("  - Wrong password shows an error");
    expect(md).toContain(`${shortHandle(next.id)} [high] Logout button`);
    // Only decisions from the last 7 days.
    expect(md).toContain(`${shortHandle(recent.id)} Use cookies`);
    expect(md).not.toContain(shortHandle(old.id));
    expect(md).toContain(`${shortHandle(feat.id)} Login (building): src/login/**`);
    expect(brief.omitted).toBe(0);
    expect(brief.tokens).toBe(estimateTokens(md));
  });

  it("tells an agent with no claim how to start, and hides empty optional sections", async () => {
    const { ctx } = await setup();
    const md = (await buildBrief(ctx)).markdown;
    expect(md).toContain("None claimed. Pick a ready task and call task_claim.");
    expect(md).toContain("No ready tasks.");
    expect(md).not.toContain("Decisions");
    expect(md).not.toContain("Protected features");
  });

  // Another agent's claim and an expired claim of mine are not "my tasks".
  it("lists only my live claims", async () => {
    const { ctx, clock } = await setup();
    const a = await createTask(ctx, { title: "Mine, expired" });
    await claimTask(ctx, a.id, { leaseMinutes: 1 });
    const other = await ensureActor(ctx, { name: "codex@x", kind: "agent", tool: "codex" });
    const b = await createTask(ctx, { title: "Theirs" });
    await claimTask({ ...ctx, actorId: other.id }, b.id);
    clock.advance(2 * 60_000);
    const md = (await buildBrief(ctx)).markdown;
    expect(md).toContain("None claimed.");
    expect(md).not.toContain("Theirs");
  });

  it("short format keeps my tasks and the top 3 ready tasks only", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 5; i++) await createTask(ctx, { title: `Task ${i}` });
    await recordDecision(ctx, { title: "A decision", decision: "x" });
    const md = (await buildBrief(ctx, { format: "short" })).markdown;
    expect(md).toContain("## Ready (top 3)");
    expect(md.match(/^- tsk_/gm)).toHaveLength(3);
    expect(md).not.toContain("A decision");
  });

  // The cap is the point of the brief: it must hold however much the project has stored.
  it("stays under the token cap on a large project, trimming the lowest sections first", async () => {
    const { ctx } = await setup();
    const long = (i: number) => `${"Very long feature title ".repeat(12)}${i}`;
    const acceptance = Array.from({ length: 200 }, (_, i) => `${"criterion ".repeat(40)}${i}`);
    const feat = await createFeature(ctx, { title: long(0), protected: true, acceptance });
    const mine = await createTask(ctx, { title: long(1), featureId: feat.id });
    await claimTask(ctx, mine.id);
    for (let i = 0; i < 300; i++) {
      await createTask(ctx, { title: long(i) });
      await recordDecision(ctx, { title: long(i), decision: "x" });
      await createFeature(ctx, { title: long(i), protected: true, paths: ["src/**"] });
    }
    const brief = await buildBrief(ctx);
    expect(brief.tokens).toBeLessThanOrEqual(BRIEF_TOKEN_CAP);
    expect(brief.omitted).toBeGreaterThan(0);
    expect(brief.markdown).toContain(shortHandle(mine.id));
    expect(brief.markdown).toContain("more left out to keep this brief short");

    const tight = await buildBrief(ctx, { maxTokens: 300 });
    expect(tight.tokens).toBeLessThanOrEqual(300);
    expect(tight.markdown).toContain(shortHandle(mine.id));
  });
});
