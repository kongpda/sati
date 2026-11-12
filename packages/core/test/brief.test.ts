import { describe, expect, it } from "vitest";
import {
  acquireLock,
  BRIEF_TOKEN_CAP,
  buildBrief,
  claimTask,
  completeTask,
  createFeature,
  createNote,
  createTask,
  ensureActor,
  estimateTokens,
  putContext,
  recordDecision,
  shortHandle,
} from "../src/index.js";
import { countingReads } from "./support/count-reads.js";
import { setup } from "./support/setup.js";

describe("buildBrief", () => {
  // Every session starts with a brief. It read the card table three times and every note ever
  // written; on a big project that was most of its cost (review 11.1).
  it("the brief reads the card table once", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "Mine", labels: ["auth"] });
    await claimTask(ctx, t.id);
    const old = await createNote(ctx, { title: "Old meeting" });
    clock.advance(30 * 24 * 60 * 60 * 1000);
    await claimTask(ctx, t.id);
    const cards = [
      await putContext(ctx, { path: "src/auth", summary: "Login", tags: ["auth"] }),
      await putContext(ctx, { path: "src/billing", summary: "Payments" }),
    ];
    const counting = countingReads(ctx);
    const brief = await buildBrief(counting.ctx);
    expect(brief.markdown).toContain("src/auth");
    expect(counting.listed("context").sort()).toEqual(cards.map((c) => c.id).sort());
    // A month-old note that is not pinned, not a handoff and not on my task is not read.
    expect(counting.listed("note")).not.toContain(old.id);
  });

  // An agent reads the rules once and the brief every session. The last line tells it which form
  // of each step works here, so an agent with no MCP client does not call tools it does not have.
  it("ends with the form of the tools in use, and only when the caller names it", async () => {
    const { ctx } = await setup();
    await createTask(ctx, { title: "Ready one" });
    expect((await buildBrief(ctx)).markdown).not.toContain("Tools:");
    expect((await buildBrief(ctx, {}, "mcp")).markdown.endsWith("\n\nTools: MCP.\n")).toBe(true);
    const cli = (await buildBrief(ctx, { format: "short" }, "cli")).markdown;
    expect(cli.trimEnd().split("\n").at(-1)).toMatch(/^Tools: CLI \(--json on every command\)/u);
  });

  // The line is the one thing a cut brief must still say; items go first.
  it("keeps the tools line when the brief is cut to its smallest size", async () => {
    const { ctx } = await setup();
    for (let i = 0; i < 12; i++) {
      const task = await createTask(ctx, { title: `A task with a long enough title, number ${i}` });
      await claimTask(ctx, task.id);
      await recordDecision(ctx, { title: `A decision worth a line, number ${i}`, decision: "y" });
    }
    const whole = await buildBrief(ctx, {}, "cli");
    expect(whole.tokens).toBeGreaterThan(200);
    const cut = await buildBrief(ctx, { maxTokens: 200 }, "cli");
    expect(cut.tokens).toBeLessThan(whole.tokens);
    expect(cut.markdown.trimEnd().split("\n").at(-1)).toMatch(/^Tools: CLI/u);
  });

  it("shows my claimed task with its feature's acceptance criteria, ready work and context", async () => {
    const { ctx, clock, actor } = await setup();
    const old = await recordDecision(ctx, { title: "Old call", decision: "x" });
    clock.advance(8 * 24 * 60 * 60 * 1000);
    const feat = await createFeature(ctx, {
      title: "Login",
      protected: true,
      status: "shipped",
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
    expect(md).toContain(`${shortHandle(feat.id)} Login (shipped): src/login/**`);
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
    // The brief also released the expired claim, so the task is offered as ready again.
    expect(md).toContain(`${shortHandle(a.id)} [medium] Mine, expired`);
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

  // A brief that lists 25 tasks in review and then no ready task tells its reader nothing to do.
  it("keeps the ready tasks when a long section above them uses up the budget", async () => {
    const { ctx } = await setup();
    const long = (i: number) => `${"Long review task title ".repeat(8)}${i}`;
    for (let i = 0; i < 25; i++) {
      const t = await claimTask(ctx, (await createTask(ctx, { title: long(i) })).id);
      await completeTask(ctx, t.id, { summary: "x", filesTouched: ["a"], token: t.claim?.token });
      await recordDecision(ctx, { title: long(i), decision: "x" });
    }
    const ready = [];
    for (let i = 0; i < 5; i++) ready.push(await createTask(ctx, { title: `Ready ${i}` }));
    const human = await ensureActor(ctx, { name: "ada@test", kind: "human" });
    const brief = await buildBrief({ ...ctx, actorId: human.id }, { maxTokens: 600 });
    expect(brief.tokens).toBeLessThanOrEqual(600);
    expect(brief.omitted).toBeGreaterThan(0);
    expect(brief.markdown).toContain("## Waiting for review\n- tsk_");
    for (const t of ready) expect(brief.markdown).toContain(shortHandle(t.id));
    // Lower sections keep a couple of lines each instead of a bare "N more left out".
    expect(brief.markdown).toMatch(/## Decisions, last 7 days\n- dec_/u);
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

    // PLAN Phase 5b: at the lowest cap, with a 200-character name and every section full, the
    // header is clipped and emptied sections fold into one line instead of a heading each.
    const other = {
      ...ctx,
      actorId: (await ensureActor(ctx, { name: "other@w", kind: "agent" })).id,
    };
    for (let i = 0; i < 10; i++) {
      await acquireLock(other, { paths: [`area${i}/**`] });
      const t = await claimTask(other, (await createTask(ctx, { title: long(i) })).id);
      await completeTask(other, t.id, { summary: "x", filesTouched: ["a"], token: t.claim?.token });
    }
    const person = await ensureActor(ctx, { name: `${"y".repeat(198)}@w`, kind: "human" });
    const long200 = { ...ctx, actorId: person.id };
    const smallest = await buildBrief(long200, { maxTokens: 200 });
    expect(smallest.tokens).toBeLessThanOrEqual(200);
    expect(smallest.markdown).not.toContain("y".repeat(61));

    // Every section present (shipped features, paths matching nothing, stale context): emptied
    // sections fold into one closing line rather than a heading each, so the cap still holds.
    const files = [{ path: "src/m0/a.ts", blob: "old" }];
    ctx.repo = { files: async () => [...files], head: async () => "h" };
    for (let i = 0; i < 10; i++) {
      await createFeature(ctx, {
        title: long(i),
        status: "shipped",
        protected: true,
        paths: [`gone${i}/**`],
      });
      await putContext(ctx, { path: `src/m${i}`, summary: long(i) });
    }
    files[0] = { path: "src/m0/a.ts", blob: "new" };
    expect((await buildBrief(ctx)).markdown).toContain("## Stale context");
    const full = await buildBrief({ ...long200, repo: ctx.repo }, { maxTokens: 200 });
    expect(full.tokens).toBeLessThanOrEqual(200);
    expect(full.markdown).toMatch(/\n… \d+ more items left out to keep this brief short\.\n$/u);
    // About 8 s alone (900+ writes); the whole gate runs every package's tests at once.
  }, 60_000);

  // PLAN: a feature glob that matches zero tracked files is reported. doctor repeats this in Phase 5.
  // Why: the brief read at most 500 active tasks and 20 decisions and never said so. Past 500
  // active tasks, the agent's own claimed task could vanish from its brief.
  it("finds my claimed task past 500 active tasks, and every decision of the last 7 days", async () => {
    const { ctx } = await setup();
    const mine = await createTask(ctx, { title: "My low task", priority: "low" });
    await claimTask(ctx, mine.id);
    const template = await createTask(ctx, { title: "Busy", priority: "urgent" });
    await ctx.store.write(async (w) => {
      for (let i = 0; i < 501; i++) {
        const id = `tsk_01JZ${String(i).padStart(22, "0")}`;
        await w.insert("task", { ...template, id, status: "blocked" });
      }
    });
    for (let i = 1; i <= 25; i++)
      await recordDecision(ctx, { title: `Choice ${i}`, decision: "x" });
    const md = (await buildBrief(ctx, { maxTokens: BRIEF_TOKEN_CAP })).markdown;
    expect(md).toContain(`${shortHandle(mine.id)} [in_progress, low] My low task`);
    const decisions = md.split("## Decisions, last 7 days")[1]?.split("\n## ")[0] ?? "";
    expect(decisions.match(/Choice \d+/gu)).toHaveLength(25);
  });

  it("names feature globs that match no tracked file", async () => {
    const { ctx } = await setup();
    const missing = await createFeature(ctx, {
      title: "Gone",
      paths: ["src/gone/**"],
    });
    const present = await createFeature(ctx, { title: "Here", paths: ["src/here.ts"] });
    // A plain folder name was reported as stale although the folder is full of files.
    const folder = await createFeature(ctx, { title: "Folder", paths: ["docs/", "assets"] });
    ctx.repo = {
      files: async () => [
        { path: "src/here.ts", blob: "abc" },
        { path: "docs/a.md", blob: "abc" },
      ],
      head: async () => "abc",
    };
    const md = (await buildBrief(ctx)).markdown;
    expect(md).toContain(`${shortHandle(missing.id)} Gone: src/gone/**`);
    expect(md).not.toContain(`${shortHandle(present.id)} Here`);
    expect(md).not.toContain(`${shortHandle(folder.id)} Folder`);
    const noRepo = await setup();
    await createFeature(noRepo.ctx, { title: "Anywhere", paths: ["src/x.ts"] });
    expect((await buildBrief(noRepo.ctx)).markdown).not.toContain("matching no tracked file");
  });
});
