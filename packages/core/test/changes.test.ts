import { describe, expect, it } from "vitest";
import {
  addComment,
  buildBrief,
  type ChangeItem,
  claimTask,
  completeTask,
  createFeature,
  createMilestone,
  createNote,
  createTask,
  ensureActor,
  featureList,
  formatChanges,
  listChanges,
  recordDecision,
  type ServiceContext,
  shortHandle,
  updateFeature,
  updateMilestone,
  updateNote,
  updateSettings,
  updateTask,
} from "../src/index.js";
import { setup } from "./support/setup.js";

const DAY = 24 * 60 * 60 * 1000;
const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ok";
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

/** Claims and completes a task; with review off it lands in done straight away. */
async function finish(ctx: ServiceContext, id: string, extra: Record<string, unknown> = {}) {
  const claimed = await claimTask(ctx, id);
  return completeTask(ctx, id, {
    summary: "did it",
    filesTouched: ["src/a.ts"],
    token: claimed.claim?.token,
    ...extra,
  });
}

const kinds = (items: ChangeItem[]) => items.map((i) => `${i.kind}:${i.title}`).sort();

describe("listChanges", () => {
  it("lists what changed in the window, and leaves out comments and what came before", async () => {
    const { ctx, clock } = await setup();
    await updateSettings(ctx, { review: "none" });
    const launch = await createMilestone(ctx, { title: "Launch" });
    const checkout = await createFeature(ctx, { title: "Checkout", milestoneId: launch.id });
    const before = await createTask(ctx, { title: "Old work" });
    await finish(ctx, before.id);
    await recordDecision(ctx, { title: "Old call", decision: "x" });
    const oldNote = await createNote(ctx, { title: "Venue facts", body: "a" });
    clock.advance(8 * DAY);

    const fix = await createTask(ctx, {
      title: "Card form crash",
      featureId: checkout.id,
      labels: ["bug"],
    });
    await finish(ctx, fix.id, { releaseNote: "Paying by card no longer crashes" });
    const internal = await createTask(ctx, { title: "Bump deps", labels: ["internal"] });
    await finish(ctx, internal.id, { summary: "bumped" });
    // Edited but not done: not a change of its own.
    const open = await createTask(ctx, { title: "Still open" });
    await updateTask(ctx, open.id, { title: "Still open, renamed" });
    await updateFeature(ctx, checkout.id, { status: "building" });
    await updateFeature(ctx, checkout.id, { status: "shipped" });
    // Added as planned: it has not moved.
    await createFeature(ctx, { title: "Gift cards" });
    await recordDecision(ctx, { title: "Use Stripe", decision: "y", featureIds: [checkout.id] });
    await createNote(ctx, { title: "Press kit", body: "b" });
    await updateNote(ctx, oldNote.id, { body: "a, updated" });
    await addComment(ctx, { on: fix.id, body: "Looks good" });
    const blocked = await createTask(ctx, { title: "Waiting on bank" });
    await updateTask(ctx, blocked.id, { status: "blocked" });
    await createTask(ctx, { title: "Send invites", dueDate: "2026-11-05" });
    await createTask(ctx, { title: "Due today", dueDate: "2026-11-11" });

    const c = await listChanges(ctx);
    expect(c.basis).toBe("the last 7 days");
    expect(kinds(c.items)).toEqual([
      "decision:Use Stripe",
      "done:Bump deps",
      "done:Card form crash",
      "feature:Checkout",
      "note:Press kit",
      "note:Venue facts",
    ]);
    const done = c.items.find((i) => i.id === fix.id);
    expect(done).toMatchObject({
      milestoneId: launch.id,
      releaseNote: "Paying by card no longer crashes",
      filesTouched: ["src/a.ts"],
    });
    expect(c.items.find((i) => i.id === oldNote.id)).toMatchObject({ edited: true });
    expect(c.items.find((i) => i.kind === "feature")).toMatchObject({
      status: "shipped",
      by: ctx.actorId,
    });
    expect(c.blocked.map((t) => t.title)).toEqual(["Waiting on bank"]);
    // Due today is not overdue yet.
    expect(c.overdue).toEqual([expect.objectContaining({ title: "Send invites" })]);

    const plain = formatChanges(c);
    expect(plain).toContain("## Launch");
    expect(plain).toContain(
      `- ${shortHandle(fix.id)} Card form crash (2026-11-11): did it. Release note: Paying by card no longer crashes. Files: src/a.ts.`,
    );
    expect(plain).toContain("## No milestone");
    expect(plain).toContain("Bump deps");

    const log = formatChanges(c, "changelog");
    expect(log).toBe(
      [
        "## Changes since 2026-11-04",
        "",
        "### Added",
        "- Checkout",
        "",
        "### Fixed",
        "- Paying by card no longer crashes",
        "",
      ].join("\n"),
    );

    const digest = formatChanges(c, "digest");
    expect(digest).toContain("1 task done, 1 decision, 2 notes new or edited.");
    expect(digest).toContain("Shipped: Checkout.");
    expect(digest).toContain("Needs attention: 1 blocked task, 1 overdue.");
    expect(digest).not.toContain("Bump deps");
  });

  it("filters by milestone and by who did it", async () => {
    const { ctx } = await setup();
    await updateSettings(ctx, { review: "none" });
    const kong = await ensureActor(ctx, { name: "kong", kind: "human", tool: null });
    const asKong = { ...ctx, actorId: kong.id };
    const launch = await createMilestone(ctx, { title: "Launch" });
    const inLaunch = await createTask(ctx, { title: "Print posters", milestoneId: launch.id });
    await finish(asKong, inLaunch.id);
    const elsewhere = await createTask(ctx, { title: "Fix wifi" });
    await finish(ctx, elsewhere.id);
    const linked = await createNote(ctx, {
      title: "Poster sizes",
      body: "A2",
      links: [inLaunch.id],
    });
    await createNote(ctx, { title: "Unrelated", body: "x" });

    const scoped = await listChanges(ctx, { milestoneId: shortHandle(launch.id) });
    expect(scoped.milestone).toEqual({ id: launch.id, title: "Launch" });
    expect(scoped.items.map((i) => i.id).sort()).toEqual([inLaunch.id, linked.id].sort());
    expect((await listChanges(ctx, { actorId: kong.id })).items.map((i) => i.id)).toEqual([
      inLaunch.id,
    ]);
  });

  it("reads since as a day, a span or a done milestone, and refuses anything else", async () => {
    const { ctx, clock } = await setup();
    expect((await listChanges(ctx, { since: "2w" })).since).toBe("2026-10-20T12:00:00.000Z");
    expect((await listChanges(ctx, { since: "24h" })).basis).toBe("the last 24 hours");
    expect((await listChanges(ctx, { since: "2026-11-01" })).since).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(await code(() => listChanges(ctx, { since: "yesterday" }))).toBe("VALIDATION");
    // Date.parse rolls 2026-02-31 over to March 3; a day that does not exist is a typo.
    expect(await code(() => listChanges(ctx, { since: "2026-02-31" }))).toBe("VALIDATION");
    const v1 = await createMilestone(ctx, { title: "v1" });
    expect(await code(() => listChanges(ctx, { since: v1.id }))).toBe("VALIDATION");
    await updateMilestone(ctx, v1.id, { status: "active" });
    clock.advance(DAY);
    await updateMilestone(ctx, v1.id, { status: "done" });
    clock.advance(DAY);
    const after = await listChanges(ctx, { since: shortHandle(v1.id) });
    expect(after.since).toBe("2026-11-04T12:00:00.000Z");
    expect(after.basis).toBe("v1 was done (2026-11-04)");
  });
});

describe("formatChanges", () => {
  it("puts each change under its changelog heading, oldest first, each line once", async () => {
    const { ctx, clock } = await setup();
    await updateSettings(ctx, { review: "none" });
    const later = await createMilestone(ctx, { title: "Later", order: 2 });
    const first = await createMilestone(ctx, { title: "First", order: 1 });
    const done = async (title: string, labels: string[], milestoneId?: string) => {
      const t = await createTask(ctx, { title, labels, milestoneId });
      clock.advance(1000);
      return finish(ctx, t.id, { summary: `${title} done` });
    };
    await done("Drop fax", ["Removed"], later.id);
    await done("Tidy menus", [], first.id);
    await done("Dark mode", ["new"]);
    const old = await createFeature(ctx, { title: "Fax", status: "building" });
    await updateFeature(ctx, old.id, { status: "shipped" });
    await updateFeature(ctx, old.id, { status: "deprecated" });
    const gone = await createFeature(ctx, { title: "Printing", status: "building" });
    await updateFeature(ctx, gone.id, { status: "removed", reviewed: true });
    // Still being built is not news for users yet.
    await createFeature(ctx, { title: "Wallets", status: "building" });
    for (const [title, dueDate] of [
      ["Late B", "2026-11-02"],
      ["Late A", "2026-11-01"],
    ]) {
      await createTask(ctx, { title, dueDate });
    }

    const c = await listChanges(ctx);
    expect(formatChanges(c, "changelog")).toBe(
      [
        "## Changes since 2026-10-27",
        "",
        "### Added",
        "- Dark mode done",
        "",
        "### Changed",
        "- Tidy menus done",
        "- Fax is deprecated",
        "",
        "### Removed",
        "- Drop fax done",
        "- Printing",
        "",
      ].join("\n"),
    );
    expect(c.overdue.map((t) => t.title)).toEqual(["Late A", "Late B"]);
    // Groups follow roadmap order, not creation order.
    const plain = formatChanges(c);
    expect(plain.indexOf("## First")).toBeLessThan(plain.indexOf("## Later"));
    expect(plain).toContain("Wallets: being built");
  });

  it("says plainly when nothing changed, and handles long and odd input", async () => {
    const { ctx } = await setup();
    const empty = await listChanges(ctx, { since: "1d" });
    expect(empty.basis).toBe("the last 1 day");
    expect(formatChanges(empty)).toContain("Nothing changed.");
    expect(formatChanges(empty, "changelog")).toContain("No user-facing changes.");
    expect(formatChanges(empty, "digest")).toContain("Nothing changed.");
    expect(await featureList(ctx)).toBe("# Demo features\n\nNo shipped features yet.\n");
    // No earlier session: fall back to a week, and say so.
    expect((await listChanges(ctx, { since: "last-session" })).basis).toBe(
      "the last 7 days (no earlier session found)",
    );
    expect((await listChanges(ctx, { since: "2026-11-02T08:30:00Z" })).since).toBe(
      "2026-11-02T08:30:00.000Z",
    );

    await updateSettings(ctx, { review: "none", kind: "general" });
    const plan = await createMilestone(ctx, { title: "Fair" });
    const files = ["a", "b", "c", "d", "e", "f", "g"].map((f) => `${f}.md`);
    const long = await createTask(ctx, { title: "x".repeat(200), milestoneId: plan.id });
    await finish(ctx, long.id, { summary: "Ended well.", filesTouched: files });
    const none = await createTask(ctx, { title: "Call the hall", milestoneId: plan.id });
    await finish(ctx, none.id, { summary: "Called", filesTouched: [] });
    const c = await listChanges(ctx, { milestoneId: plan.id });
    const plain = formatChanges(c);
    expect(plain).toContain("in Fair: 2 changes.");
    expect(plain).toContain(`${"x".repeat(119)}…`);
    expect(plain).toContain("Ended well. Files: a.md, b.md, c.md, d.md, e.md (+2).");
    expect(plain).toContain("Call the hall (2026-11-03): Called.\n");
    expect(formatChanges(c, "digest")).toMatch(/^Demo in Fair: /u);
  });

  it("keeps the digest short", async () => {
    const { ctx } = await setup();
    await updateSettings(ctx, { review: "none" });
    for (let i = 0; i < 7; i++) {
      await finish(ctx, (await createTask(ctx, { title: `Task ${i}` })).id);
      await recordDecision(ctx, { title: `Call ${i}`, decision: "x" });
    }
    const digest = formatChanges(await listChanges(ctx), "digest");
    expect(digest).toContain("7 tasks done, 7 decisions, 0 notes new or edited.");
    expect(digest).toContain("- and 2 more\n");
    expect(digest).toContain("- and 4 more\n");
    expect(digest.split("\n").length).toBeLessThan(20);
  });

  // The digest goes to people outside the team; `internal` work must not reach it, blocked or not.
  it("leaves internal tasks out of the digest's needs-attention list", async () => {
    const { ctx } = await setup();
    const secret = await createTask(ctx, {
      title: "Quiet vendor swap",
      labels: ["internal"],
      dueDate: "2026-11-01",
    });
    const visible = await createTask(ctx, { title: "Book the hall" });
    for (const t of [secret, visible]) {
      const claimed = await claimTask(ctx, t.id);
      await updateTask(ctx, t.id, {
        status: "blocked",
        reason: "waiting",
        token: claimed.claim?.token,
      });
    }
    const digest = formatChanges(await listChanges(ctx), "digest");
    expect(digest).toContain("Book the hall (blocked)");
    expect(digest).not.toContain("Quiet vendor swap");
    expect(digest).toContain("Needs attention: 1 blocked task, 0 overdue.");
  });
});

// Why: milestone titles take 300 characters and went into the heading and summary uncut, while
// every other title in `sati changes` is clipped.
it("clips long milestone titles like every other title", async () => {
  const { ctx } = await setup();
  await updateSettings(ctx, { review: "none" });
  const long = "M".repeat(300);
  const plan = await createMilestone(ctx, { title: long });
  const t = await createTask(ctx, { title: "Ship it", milestoneId: plan.id });
  await finish(ctx, t.id);
  await createTask(ctx, { title: "Loose" }).then((x) => finish(ctx, x.id));
  const c = await listChanges(ctx, { since: "1d" });
  expect(formatChanges(c)).toContain(`## ${"M".repeat(100)}`);
  expect(formatChanges(c)).not.toContain(long);
  const scoped = await listChanges(ctx, { since: "1d", milestoneId: plan.id });
  for (const format of ["plain", "digest", "changelog"] as const) {
    expect(formatChanges(scoped, format)).not.toContain(long);
  }
});

describe("since your last session", () => {
  it("shows a new session what others did after the previous session's last write", async () => {
    const { ctx, clock } = await setup();
    await updateSettings(ctx, { review: "none" });
    await createTask(ctx, { title: "Session one work" });
    clock.advance(DAY);
    const kong = await ensureActor(ctx, { name: "kong", kind: "human", tool: null });
    const asKong = { ...ctx, actorId: kong.id };
    const t = await createTask(asKong, { title: "Book the venue" });
    await finish(asKong, t.id);
    await recordDecision(asKong, { title: "Hold it in March", decision: "x" });

    // A later Claude Code session is a new actor with the same identity.
    const two = await ensureActor(ctx, {
      name: "claude-code@main#2",
      kind: "agent",
      tool: "claude-code",
    });
    const asTwo = { ...ctx, actorId: two.id };
    const md = (await buildBrief(asTwo)).markdown;
    expect(md).toContain("## Since your last session (2026-11-03 12:00 UTC)");
    expect(md).toContain(`- ${shortHandle(t.id)} done: Book the venue (kong, 11-04)`);
    expect(md).toContain("decided: Hold it in March (kong, 11-04)");
    // The earlier session's own work is not news to this one.
    expect(md.split("## Since your last session")[1]).not.toContain("Session one work");

    const c = await listChanges(asTwo, { since: "last-session" });
    expect(c.since).toBe("2026-11-03T12:00:00.000Z");
    expect(c.basis).toBe("your last session (2026-11-03 12:00 UTC)");
  });

  // Why: agents get a new actor per session, and the brief ran one activity query per earlier
  // session, so every session start got slower as the project aged.
  it("finds the last session with one activity read, however many sessions there were", async () => {
    const { ctx, clock } = await setup();
    for (let i = 1; i <= 30; i++) {
      const s = await ensureActor(ctx, {
        name: `claude-code@main#${i}`,
        kind: "agent",
        tool: null,
      });
      await createTask({ ...ctx, actorId: s.id }, { title: `Session ${i} work` });
      clock.advance(60_000);
    }
    const now = await ensureActor(ctx, { name: "claude-code@main#31", kind: "agent", tool: null });
    let reads = 0;
    const store = ctx.store;
    const counted: typeof store = Object.create(store);
    counted.read = (fn) =>
      store.read((r) =>
        fn(
          Object.assign(Object.create(r), {
            listActivity: (...args: Parameters<typeof r.listActivity>) => {
              reads++;
              return r.listActivity(...args);
            },
          }),
        ),
      );
    const c = await listChanges(
      { ...ctx, store: counted, actorId: now.id },
      { since: "last-session" },
    );
    expect(reads).toBe(1);
    // The newest earlier session wins, not the first one found.
    expect(c.since).toBe(
      new Date(Date.parse("2026-11-03T12:00:00.000Z") + 29 * 60_000).toISOString(),
    );
  });

  it("is not moved by the expired claims the brief releases in your name", async () => {
    const { ctx, clock } = await setup();
    const kong = await ensureActor(ctx, { name: "kong", kind: "human", tool: null });
    const asKong = { ...ctx, actorId: kong.id };
    const mine = await createTask(asKong, { title: "Mine" });
    await claimTask(asKong, mine.id, { leaseMinutes: 1 });
    clock.advance(DAY);
    await recordDecision(ctx, { title: "Agent call", decision: "x" });
    clock.advance(DAY);
    // The brief releases kong's expired claim, a write in kong's name, after reading the window.
    const first = (await buildBrief(asKong)).markdown;
    expect(first).toContain("decided: Agent call");
    // No earlier session at all: no section, rather than a guess.
    const fresh = await ensureActor(ctx, { name: "codex@main", kind: "agent", tool: "codex" });
    expect((await buildBrief({ ...ctx, actorId: fresh.id })).markdown).not.toContain(
      "Since your last session",
    );
  });

  it("caps the section at five lines and points to the rest", async () => {
    const { ctx, clock } = await setup();
    await createTask(ctx, { title: "Before" });
    clock.advance(1000);
    const kong = await ensureActor(ctx, { name: "kong", kind: "human", tool: null });
    for (let i = 0; i < 7; i++) {
      await recordDecision({ ...ctx, actorId: kong.id }, { title: `Call ${i}`, decision: "x" });
    }
    const two = await ensureActor(ctx, {
      name: "claude-code@main#2",
      kind: "agent",
      tool: "claude-code",
    });
    const md = (await buildBrief({ ...ctx, actorId: two.id })).markdown;
    const section = md.split("## Since your last session")[1]?.split("\n## ")[0] ?? "";
    expect(section.match(/decided: /gu)).toHaveLength(5);
    expect(section).toContain("- … 2 more: `sati changes --since last-session`");
  });
});

describe("featureList", () => {
  it("prints shipped features with acceptance criteria, grouped by milestone", async () => {
    const { ctx } = await setup();
    const v1 = await createMilestone(ctx, { title: "v1" });
    await createFeature(ctx, {
      title: "Search",
      status: "shipped",
      milestoneId: v1.id,
      description: "Find anything.\n\nInternals: FTS5.",
      acceptance: ["Typos still match"],
    });
    await createFeature(ctx, { title: "Export", status: "deprecated" });
    await createFeature(ctx, { title: "Gift cards", status: "planned" });
    expect(await featureList(ctx)).toBe(
      [
        "# Demo features",
        "",
        "## v1",
        "",
        "### Search",
        "",
        "Find anything.",
        "",
        "- Typos still match",
        "",
        "## Other features",
        "",
        "### Export (deprecated)",
        "",
      ].join("\n"),
    );
  });
});
