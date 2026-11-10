import { describe, expect, it } from "vitest";
import {
  acknowledgeHandoff,
  acquireLock,
  adoptClaims,
  buildBrief,
  claimHealth,
  claimTask,
  completeTask,
  createTask,
  deleteRecord,
  doctorChecks,
  ensureActor,
  getRecord,
  importRecords,
  markWaiting,
  type ProcessProbe,
  type RepoIndex,
  releaseExpiredClaims,
  releaseTask,
  removableWorktrees,
  reviewDrift,
  type ServiceContext,
  shortHandle,
  updateNote,
  updateTask,
  worktreeWarnings,
  writeHandoff,
} from "../src/index.js";
import { setup } from "./support/setup.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

async function as(ctx: ServiceContext, name: string, kind: "agent" | "human", worktree?: string) {
  const actor = await ensureActor(ctx, {
    name,
    kind,
    tool: kind === "agent" ? "codex" : null,
    worktree: worktree ?? null,
  });
  return { ...ctx, actorId: actor.id };
}

describe("waiting on a person", () => {
  it("the holder asks, its next write clears it, and a person can clear it too", async () => {
    const { ctx } = await setup();
    const person = await as(ctx, "kim@main", "human");
    const t = await createTask(ctx, { title: "Pick a database" });
    const claimed = await claimTask(ctx, t.id);
    const token = claimed.claim?.token;

    const [asked] = await markWaiting(ctx, {
      taskId: t.id,
      waiting: { text: "Postgres or SQLite?" },
    });
    expect(asked?.claim?.waiting).toMatchObject({ kind: "question", text: "Postgres or SQLite?" });
    expect(asked?.claim?.token).toBe(token);
    const brief = await buildBrief(person);
    expect(brief.markdown).toContain("## Needs you");
    expect(brief.markdown).toContain("asks: Postgres or SQLite?");

    // Any later write by the holder means it moved on.
    const moved = await updateTask(ctx, t.id, { token, body: "Going with SQLite." });
    expect(moved.claim?.waiting).toBeUndefined();
    expect(moved.claim?.actorId).toBe(ctx.actorId);

    const again = await updateTask(ctx, t.id, { token, needsInput: "Which region?" });
    expect(again.claim?.waiting?.text).toBe("Which region?");
    const [answered] = await markWaiting(person, { taskId: t.id, waiting: null });
    expect(answered?.claim?.waiting).toBeUndefined();
    // The person cleared the flag without taking the claim or its token.
    expect(answered?.claim).toMatchObject({ actorId: ctx.actorId, token });
  });

  it("only the holder says it is waiting", async () => {
    const { ctx } = await setup();
    const other = await as(ctx, "codex@b", "agent");
    const t = await createTask(ctx, { title: "x" });
    await claimTask(ctx, t.id);
    await expect(
      markWaiting(other, { taskId: t.id, waiting: { text: "mine now?" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(markWaiting(other, { taskId: t.id, waiting: null })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const free = await createTask(ctx, { title: "unclaimed" });
    await expect(updateTask(ctx, free.id, { needsInput: "?" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("a blocked task carries its reason until it leaves blocked", async () => {
    const { ctx } = await setup();
    const person = await as(ctx, "kim@main", "human");
    const t = await createTask(ctx, { title: "Ship billing" });
    const blocked = await updateTask(ctx, t.id, { status: "blocked", reason: "No Stripe key yet" });
    expect(blocked.blockedReason).toBe("No Stripe key yet");
    expect((await buildBrief(person)).markdown).toContain("blocked: No Stripe key yet");
    const back = await updateTask(ctx, t.id, { status: "todo" });
    expect(back.blockedReason).toBeNull();
  });
});

describe("review pinned to a commit", () => {
  async function inReview() {
    const s = await setup();
    const heads: Record<string, string> = { main: A };
    const repo: RepoIndex = {
      files: async () => [],
      head: async () => heads.main ?? null,
      branchHead: async (b) => heads[b] ?? null,
    };
    const ctx = { ...s.ctx, repo };
    const person = await as(ctx, "kim@main", "human");
    const t = await createTask(ctx, { title: "Add export" });
    const { claim } = await claimTask(ctx, t.id);
    const sent = await completeTask(ctx, t.id, {
      summary: "done",
      filesTouched: ["src/export.ts"],
      token: claim?.token,
    });
    return { ctx, person, heads, task: sent };
  }

  it("records the commit and branch the work was sent at", async () => {
    const { task } = await inReview();
    expect(task.status).toBe("review");
    expect(task.completion).toMatchObject({ commit: A, branch: "main" });
  });

  it("refuses an approval of a commit the branch has moved past", async () => {
    const { ctx, person, heads, task } = await inReview();
    heads.main = B;
    expect((await reviewDrift(ctx, [task])).get(task.id)).toMatchObject({ moved: true, head: B });
    expect((await buildBrief(person)).markdown).toContain("the branch changed after it was sent");
    await expect(
      updateTask(person, task.id, { status: "done", approvedCommit: A }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const done = await updateTask(person, task.id, { status: "done", approvedCommit: B });
    expect(done.completion?.approvedCommit).toBe(B);
    // Drift is measured from the approval now.
    expect((await reviewDrift(ctx, [done])).get(task.id)?.moved).toBe(false);
  });

  it("an approval without a commit pins the branch head it happened at", async () => {
    const { person, heads, task } = await inReview();
    heads.main = B;
    const done = await updateTask(person, task.id, { status: "done" });
    expect(done.completion?.approvedCommit).toBe(B);
  });

  it("does not count a commit that only touched .sati/ as a move", async () => {
    const { ctx, person, heads, task } = await inReview();
    heads.main = B;
    let changed = [".sati/tasks/tsk_x.json", ".sati"];
    const repo = { ...ctx.repo, changedBetween: async () => changed } as RepoIndex;
    const git = { ...ctx, repo };
    const reviewer = { ...person, repo };
    expect((await reviewDrift(git, [task])).get(task.id)?.moved).toBe(false);
    // A sibling folder that merely starts with the same letters is real work.
    changed = [".sati/tasks/tsk_x.json", ".satisfy/run.ts"];
    expect((await reviewDrift(git, [task])).get(task.id)?.moved).toBe(true);
    await expect(
      updateTask(reviewer, task.id, { status: "done", approvedCommit: A }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    changed = [".sati/tasks/tsk_x.json"];
    const done = await updateTask(reviewer, task.id, { status: "done", approvedCommit: A });
    expect(done.completion?.approvedCommit).toBe(A);
  });
});

describe("claims of stopped agents", () => {
  const probe = (alive: boolean | null): ProcessProbe => ({
    self: { host: "box", pid: 4242 },
    alive: () => alive,
  });

  it("are released once the holder process has exited and stayed quiet", async () => {
    const { ctx, clock } = await setup();
    const t = await createTask(ctx, { title: "x" });
    const held = await claimTask({ ...ctx, processes: probe(true) }, t.id);
    expect(held.claim?.holder).toEqual({ host: "box", pid: 4242 });

    // Exited, but it wrote 10 seconds ago: keep it.
    clock.advance(10_000);
    const dead = { ...ctx, processes: probe(false) };
    expect(claimHealth(dead, [held]).gone).toHaveLength(0);
    // An unknown answer never counts, however long it has been quiet.
    clock.advance(5 * 60_000);
    expect(claimHealth({ ...ctx, processes: probe(null) }, [held]).gone).toHaveLength(0);

    // Count the task reads: doctor read every task three times (claims, review, links).
    let taskReads = 0;
    const store = ctx.store;
    const counted: typeof store = Object.create(store);
    counted.read = (fn) =>
      store.read((r) =>
        fn(
          Object.assign(Object.create(r), {
            list: (...args: Parameters<typeof r.list>) => {
              if (args[0] === "task") taskReads++;
              return r.list(...args);
            },
          }),
        ),
      );
    const checks = await doctorChecks({ ...dead, store: counted });
    expect(taskReads).toBe(1);
    const claims = checks.find((c) => c.name === "claims");
    expect(claims).toMatchObject({ ok: false });
    // Short handles, like every other line doctor prints.
    expect(claims?.detail).toContain(`(${shortHandle(t.id)})`);
    expect(claims?.detail).not.toContain(t.id);
    const released = await releaseExpiredClaims(dead);
    expect(released.map((r) => r.id)).toEqual([t.id]);
    expect((await getRecord(ctx, "task", t.id)).status).toBe("todo");
  });

  // A reloaded MCP server works on under a new process id; its claims must follow it, not lapse.
  it("a restarted server adopts its actor's claims only when the old process has exited", async () => {
    const { ctx, clock } = await setup();
    const old = { ...ctx, processes: { self: { host: "box", pid: 1 }, alive: () => true } };
    const mine = await claimTask(old, (await createTask(ctx, { title: "mine" })).id);
    const other = await as(ctx, "codex@b", "agent");
    await claimTask(
      { ...other, processes: old.processes },
      (await createTask(ctx, { title: "theirs" })).id,
    );
    const restarted = (alive: boolean | null) => ({
      ...ctx,
      processes: { self: { host: "box", pid: 2 }, alive: () => alive },
    });
    // The old process still runs (a second session as the same actor), or nobody can tell.
    expect(await adoptClaims(restarted(true))).toEqual([]);
    expect(await adoptClaims(restarted(null))).toEqual([]);

    const adopted = await adoptClaims(restarted(false));
    expect(adopted.map((t) => t.id)).toEqual([mine.id]);
    expect(adopted[0]?.claim).toMatchObject({ holder: { pid: 2 }, token: mine.claim?.token });
    // Now held by a live process, the claim survives a stopped-agent sweep.
    clock.advance(5 * 60_000);
    const sweep = { ...ctx, processes: { alive: (h: { pid: number }) => h.pid === 2 } };
    expect((await releaseExpiredClaims(sweep)).map((t) => t.id)).not.toContain(mine.id);
    // Adopting again is a no-op.
    expect(await adoptClaims(restarted(false))).toEqual([]);
  });

  it("releases none when most holders look stopped at once", async () => {
    const { ctx, clock } = await setup();
    const alive = { ...ctx, processes: probe(true) };
    for (let i = 0; i < 3; i++)
      await claimTask(alive, (await createTask(ctx, { title: `t${i}` })).id);
    clock.advance(5 * 60_000);
    const dead = { ...ctx, processes: probe(false) };
    expect(await releaseExpiredClaims(dead)).toEqual([]);
    const checks = await doctorChecks(dead);
    expect(checks.find((c) => c.name === "holders")?.detail).toContain("look stopped at once");
    expect(checks.find((c) => c.name === "claims")?.ok).toBe(true);
  });
});

describe("handoffs", () => {
  it("reach the next claimer once, with the claim", async () => {
    const { ctx } = await setup();
    const b = await as(ctx, "codex@b", "agent");
    const c = await as(ctx, "codex@c", "agent");
    const t = await createTask(ctx, { title: "Migrate" });
    await claimTask(ctx, t.id);
    await writeHandoff(ctx, { taskId: t.id, next: "Run the second migration" });
    // Reading your own note back does not mark it read for the next agent.
    const mine = await releaseTask(ctx, t.id).then(() => claimTask(ctx, t.id));
    expect(mine.handoff?.body).toContain("Run the second migration");
    await releaseTask(ctx, t.id);

    const got = await claimTask(b, t.id);
    expect(got.handoff?.body).toContain("Run the second migration");
    const note = await getRecord(ctx, "note", got.handoff?.id ?? "");
    expect(note.acknowledged?.by).toBe(b.actorId);
    await releaseTask(b, t.id);
    expect((await claimTask(c, t.id)).handoff).toBeUndefined();
  });

  it("addressed to one actor wait for that actor, and a rewrite is unread again", async () => {
    const { ctx } = await setup();
    const b = await as(ctx, "codex@b", "agent");
    const c = await as(ctx, "codex@c", "agent");
    const t = await createTask(ctx, { title: "Migrate" });
    const note = await writeHandoff(ctx, { taskId: t.id, next: "For C only", to: c.actorId });
    expect((await claimTask(b, t.id)).handoff).toBeUndefined();
    expect((await buildBrief(c)).markdown).toContain("## Handoffs for you");
    await expect(acknowledgeHandoff(b, note.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await acknowledgeHandoff(c, note.id)).acknowledged?.by).toBe(c.actorId);
    expect((await buildBrief(c)).markdown).not.toContain("## Handoffs for you");

    const rewritten = await writeHandoff(ctx, { taskId: t.id, next: "Changed plan" });
    expect(rewritten.acknowledged).toBeUndefined();
    expect(rewritten.handoffTo).toBeUndefined();
    expect(rewritten.handoffToName).toBeUndefined();
  });

  // Actors are machine-local, so in a teammate's clone the addressee has another id.
  it("addressed to one actor reach that actor in a teammate's clone, by name", async () => {
    const mine = await setup();
    const kimHere = await as(mine.ctx, "kim@app", "agent");
    const t = await createTask(mine.ctx, { title: "Migrate" });
    const note = await writeHandoff(mine.ctx, {
      taskId: t.id,
      next: "For Kim",
      to: kimHere.actorId,
    });
    expect(note.handoffToName).toBe("kim@app");

    const theirs = await setup();
    const at = { projectId: theirs.ctx.projectId };
    await importRecords(theirs.ctx, [
      { entity: "task", source: `tasks/${t.id}.json`, record: { ...t, ...at } },
      { entity: "note", source: `notes/${note.id}.json`, record: { ...note, ...at } },
    ]);
    const kim = await as(theirs.ctx, "kim@app", "agent");
    const lee = await as(theirs.ctx, "lee@app", "agent");
    expect(kim.actorId).not.toBe(kimHere.actorId);
    // The author is unknown here too; the brief names them from the note.
    expect(note.handoffFromName).toBeTruthy();
    expect((await buildBrief(kim)).markdown).toContain(`from ${note.handoffFromName}`);
    expect((await buildBrief(lee)).markdown).not.toContain("## Handoffs for you");
    expect((await buildBrief(kim)).markdown).toContain("## Handoffs for you");
    expect((await claimTask(lee, t.id)).handoff).toBeUndefined();
    await releaseTask(lee, t.id);
    expect((await claimTask(kim, t.id)).handoff?.id).toBe(note.id);
  });

  it("are acknowledged on their own, never by their author unless addressed", async () => {
    const { ctx } = await setup();
    const b = await as(ctx, "codex@b", "agent");
    const t = await createTask(ctx, { title: "x" });
    const note = await writeHandoff(ctx, { taskId: t.id, next: "n" });
    await expect(acknowledgeHandoff(ctx, note.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      updateNote(b, note.id, { acknowledge: true, title: "renamed" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await updateNote(b, note.id, { acknowledge: true })).acknowledged?.by).toBe(b.actorId);
  });
});

describe("worktree overlaps", () => {
  it("warns about a file both agents changed that no lock covers", async () => {
    const { ctx } = await setup();
    const changed: Record<string, string[]> = {
      // Every agent's writes export to .sati/, so it is changed everywhere and means nothing.
      "/w/a": ["src/x.ts", "src/y.ts", "README.md", ".sati/tasks/t.json", "new/"],
      "/w/b": ["src/z.ts", "src/y.ts", "src/x.ts", ".sati/tasks/t.json", "new/"],
    };
    const repo: RepoIndex = {
      files: async () => [],
      head: async () => null,
      changedFiles: async (w) => changed[w] ?? null,
      baseConflicts: async () => ({ base: "origin/main", files: ["src/q.ts"] }),
    };
    const a = { ...(await as(ctx, "codex@a", "agent", "/w/a")), repo };
    const b = { ...(await as(ctx, "codex@b", "agent", "/w/b")), repo };
    const tb = await claimTask(b, (await createTask(ctx, { title: "B work" })).id);
    await claimTask(a, (await createTask(ctx, { title: "A work" })).id);
    await acquireLock(b, { paths: ["src/y.ts"] });

    const w = await worktreeWarnings(a);
    expect(w.overlaps).toEqual([
      expect.objectContaining({ path: "src/x.ts", actorId: b.actorId, taskId: tb.id }),
    ]);
    expect(w.conflicts?.files).toEqual(["src/q.ts"]);
    const brief = (await buildBrief(a)).markdown;
    expect(brief).toContain("src/x.ts is also changed by codex@b");
    expect(brief).toContain("Your branch conflicts with origin/main in src/q.ts");
    // Checking given paths only looks at those.
    expect((await worktreeWarnings(a, { paths: ["README.md"] })).overlaps).toEqual([]);
    // Why: a glob, as lock paths are written, matched no changed file, so it found nothing.
    // The locked src/y.ts stays out.
    const area = (await worktreeWarnings(a, { paths: ["src/**"] })).overlaps.map((o) => o.path);
    expect(area.sort()).toEqual(["src/x.ts", "src/z.ts"]);
  });

  it("skips expired and placeless holders, says nothing without git, and caps the list", async () => {
    const { ctx, clock } = await setup();
    const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const changed: Record<string, string[]> = { "/w/a": many, "/w/b": many, "/w/c": many };
    const repo: RepoIndex = {
      files: async () => [],
      head: async () => null,
      changedFiles: async (w) => changed[w] ?? null,
    };
    const a = { ...(await as(ctx, "codex@a", "agent", "/w/a")), repo };
    const b = { ...(await as(ctx, "codex@b", "agent", "/w/b")), repo };
    const c = { ...(await as(ctx, "codex@c", "agent", "/w/c")), repo };
    const nowhere = { ...(await as(ctx, "codex@nowhere", "agent")), repo };
    await claimTask(a, (await createTask(ctx, { title: "A" })).id);
    // B holds two tasks in one worktree: it is reported once.
    await claimTask(b, (await createTask(ctx, { title: "B1" })).id);
    await claimTask(b, (await createTask(ctx, { title: "B2" })).id);
    await claimTask(nowhere, (await createTask(ctx, { title: "No worktree" })).id);
    await claimTask(c, (await createTask(ctx, { title: "C" })).id, { leaseMinutes: 1 });
    clock.advance(2 * 60_000);

    const w = await worktreeWarnings(a, { conflicts: false });
    expect(w.conflicts).toBeNull();
    expect(w.overlaps).toHaveLength(20);
    expect(new Set(w.overlaps.map((o) => o.actorId))).toEqual(new Set([b.actorId]));
    // A path that is not repo-relative is dropped, not matched.
    expect((await worktreeWarnings(a, { paths: ["/etc/passwd"] })).overlaps).toEqual([]);
    // Outside git, or with an older git, there is nothing to compare.
    expect(await worktreeWarnings({ ...a, repo: { files: repo.files, head: repo.head } })).toEqual({
      overlaps: [],
      conflicts: null,
    });
    // An agent with no worktree of its own has changed nothing to compare.
    expect((await worktreeWarnings(nowhere)).overlaps).toEqual([]);
  });

  it("lists only clean, merged worktrees nobody works in, quoted for the shell", async () => {
    const { ctx } = await setup();
    const b = await as(ctx, "codex@b", "agent", "/w/busy");
    await claimTask(b, (await createTask(ctx, { title: "B" })).id);
    const list = await removableWorktrees(ctx, [
      { path: "/w/old it's", branch: "feat/old", clean: true, merged: true },
      { path: "/w/busy", branch: "x", clean: true, merged: true },
      { path: "/w/dirty", branch: "d", clean: false, merged: true },
      { path: "/w/open", branch: "o", clean: true, merged: false },
    ]);
    expect(list).toEqual([
      {
        path: "/w/old it's",
        branch: "feat/old",
        command: "git worktree remove '/w/old it'\\''s'",
      },
    ]);
  });
});

// Review 1.7: claims travel in .sati/ so teammates see a task is taken, but actors stay on their
// machine. A claim imported from a teammate's clone used to show a raw actor id.
describe("a claim from a teammate's clone", () => {
  it("is named 'another machine' and still guards the task", async () => {
    const mine = await setup();
    const t = await claimTask(mine.ctx, (await createTask(mine.ctx, { title: "Migrate" })).id);
    const theirs = await setup();
    await importRecords(theirs.ctx, [
      {
        entity: "task",
        source: `tasks/${t.id}.json`,
        record: { ...t, projectId: theirs.ctx.projectId },
      },
    ]);
    const agent = await as(theirs.ctx, "codex@b", "agent");
    const lock = await acquireLock(agent, { paths: ["src/**"], taskId: t.id }).catch((e) => e);
    expect(lock).toMatchObject({ code: "CONFLICT" });
    expect(lock.message).toBe(`Task ${t.id} is claimed by another machine.`);
    const removal = await deleteRecord(agent, "task", t.id).catch((e) => e);
    expect(removal.message).toBe(`Task ${t.id} is claimed by another machine.`);
    expect(removal.message).not.toContain(t.claim?.actorId);
  });
});

// Review WP2.1 (owner decision): a task in review or blocked keeps its claim while nobody works
// on it. Refusing locks tagged with it would shut other agents out for the whole lease.
describe("a lock tagged with another agent's task", () => {
  it("is refused only while that task is in progress", async () => {
    const { ctx } = await setup();
    const a = await as(ctx, "claude@a", "agent");
    const b = await as(ctx, "codex@b", "agent");
    const t = await claimTask(a, (await createTask(a, { title: "Ship" })).id);
    const tagged = () => acquireLock(b, { paths: ["src/**"], taskId: t.id });
    await expect(tagged()).rejects.toMatchObject({ code: "CONFLICT" });
    await updateTask(a, t.id, { status: "blocked", token: t.claim?.token });
    expect((await getRecord(a, "task", t.id)).claim).not.toBeNull();
    const lock = await tagged();
    expect(lock.lock.paths).toEqual(["src/**"]);
  });
});
