import { describe, expect, it } from "vitest";
import {
  createFeature,
  createMilestone,
  createNote,
  createTask,
  ensureActor,
  getProject,
  getRecord,
  initProject,
  listRecords,
  recordDecision,
  updateFeature,
  updateMilestone,
  updateNote,
} from "../src/index.js";
import { setup } from "./support/setup.js";

describe("project", () => {
  it("init writes the project, its first actor and an init row", async () => {
    const { store, project, actor } = await setup();
    expect(project).toMatchObject({ slug: "demo", mode: "git", settings: { leaseMinutes: 30 } });
    expect(project.createdBy).toBe(actor.id);
    expect(store.activity.map((a) => a.verb)).toEqual(["create", "init"]);
    expect(await getProject(store)).toEqual(project);
  });

  it("init runs once per database", async () => {
    const { store, clock, ctx } = await setup();
    await expect(
      initProject(
        { store, clock, ids: ctx.ids },
        { slug: "again", name: "Again" },
        { name: "x", kind: "human" },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("ensureActor keeps one ID per identity", async () => {
    const { store, clock, ctx, actor } = await setup();
    const deps = { store, clock, ids: ctx.ids, projectId: ctx.projectId };
    expect((await ensureActor(deps, { name: "claude-code@main#1", kind: "agent" })).id).toBe(
      actor.id,
    );
    const other = await ensureActor(deps, { name: "codex@feat#2", kind: "agent" });
    expect(other.id).not.toBe(actor.id);
    expect(store.activity.at(-1)).toMatchObject({ verb: "create", actorId: other.id });
  });
});

describe("feature", () => {
  // Shipped features are what users rely on; removing one must leave a written reason.
  it("needs a Decision listing the feature to remove a shipped feature", async () => {
    const { ctx } = await setup();
    const f = await createFeature(ctx, { title: "Export", status: "building" });
    await updateFeature(ctx, f.id, { status: "shipped" });
    await expect(updateFeature(ctx, f.id, { status: "removed" })).rejects.toMatchObject({
      code: "VALIDATION",
      hint: expect.stringContaining("decision record"),
    });
    const unrelated = await recordDecision(ctx, { title: "Other", decision: "n/a" });
    await expect(
      updateFeature(ctx, f.id, { status: "removed", decisionId: unrelated.id }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const why = await recordDecision(ctx, {
      title: "Drop export",
      decision: "Nobody uses it",
      featureIds: [f.id],
    });
    const removed = await updateFeature(ctx, f.id, { status: "removed", decisionId: why.id });
    expect(removed.status).toBe("removed");
  });

  it("drops a planned feature without a Decision", async () => {
    const { ctx } = await setup();
    const f = await createFeature(ctx, { title: "Idea" });
    expect((await updateFeature(ctx, f.id, { status: "removed" })).status).toBe("removed");
  });

  it("enforces the feature status machine", async () => {
    const { ctx } = await setup();
    const f = await createFeature(ctx, { title: "x" });
    await expect(updateFeature(ctx, f.id, { status: "shipped" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });
});

describe("milestone", () => {
  it("appends new milestones to the end of the roadmap", async () => {
    const { ctx } = await setup();
    const a = await createMilestone(ctx, { title: "Alpha" });
    const b = await createMilestone(ctx, { title: "Beta" });
    expect([a.order, b.order]).toEqual([0, 1]);
  });

  it("enforces planned -> active -> done", async () => {
    const { ctx } = await setup();
    const m = await createMilestone(ctx, { title: "Alpha" });
    await expect(updateMilestone(ctx, m.id, { status: "done" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
    await updateMilestone(ctx, m.id, { status: "active" });
    expect((await updateMilestone(ctx, m.id, { status: "done" })).status).toBe("done");
  });
});

describe("decision", () => {
  it("requires the decision text and real references", async () => {
    const { ctx } = await setup();
    await expect(recordDecision(ctx, { title: "x", decision: "" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      recordDecision(ctx, {
        title: "x",
        decision: "y",
        supersedes: "dec_01JC0000000000000000000099",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("note", () => {
  it("creates and edits notes", async () => {
    const { ctx } = await setup();
    const n = await createNote(ctx, { title: "Research", tags: ["fts"] });
    const u = await updateNote(ctx, n.id, { body: "BM25 ranks well", pinned: true });
    expect(u).toMatchObject({ body: "BM25 ranks well", pinned: true, version: 2 });
    expect(await listRecords(ctx, "note")).toHaveLength(1);
  });
});

describe("reads", () => {
  it("hides records of other projects", async () => {
    const a = await setup();
    const t = await createTask(a.ctx, { title: "x" });
    await expect(
      getRecord({ ...a.ctx, projectId: "prj_01JC0000000000000000000099" }, "task", t.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
