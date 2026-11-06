import { describe, expect, it } from "vitest";
import {
  acquireLock,
  checkChanges,
  createFeature,
  ensureActor,
  recordDecision,
  recordGuard,
  type ServiceContext,
} from "../src/index.js";
import { setup } from "./support/setup.js";

async function otherActor(ctx: ServiceContext): Promise<ServiceContext> {
  const actor = await ensureActor(ctx, { name: "codex@main#2", kind: "agent", tool: "codex" });
  return { ...ctx, actorId: actor.id };
}

async function billing(ctx: ServiceContext, isProtected = true) {
  return createFeature(ctx, {
    title: "Billing",
    status: "shipped",
    protected: isProtected,
    paths: ["src/billing/**"],
  });
}

describe("checkChanges: protected features", () => {
  // PLAN: deleting a file of a shipped, protected feature is blocked.
  it("blocks deleting a file of a shipped, protected feature", async () => {
    const { ctx } = await setup();
    const f = await billing(ctx);
    const r = await checkChanges(ctx, {
      changes: [{ path: "src/billing/invoice.ts", kind: "deleted", baseLines: 40 }],
    });
    expect(r.verdict).toBe("blocked");
    expect(r.findings).toEqual([
      expect.objectContaining({
        level: "blocked",
        rule: "protected-delete",
        featureId: f.id,
        paths: ["src/billing/invoice.ts"],
      }),
    ]);
  });

  // PLAN: "unless a Decision referencing that feature exists".
  it("lets the deletion through as a warning once a Decision lists the feature", async () => {
    const { ctx } = await setup();
    const f = await billing(ctx);
    const d = await recordDecision(ctx, {
      title: "Drop invoices",
      decision: "Invoices move to the new service.",
      featureIds: [f.id],
    });
    const r = await checkChanges(ctx, {
      changes: [{ path: "src/billing/invoice.ts", kind: "deleted" }],
    });
    expect(r.verdict).toBe("warn");
    expect(r.findings[0]).toMatchObject({ rule: "protected-delete", decisionId: d.id });
  });

  // PLAN: removing more than 50% of a protected feature's lines is blocked; the limit is configurable.
  it("blocks gutting a protected feature past the removal limit, and only past it", async () => {
    const { ctx } = await setup();
    await billing(ctx);
    const changes = [
      { path: "src/billing/a.ts", removedLines: 60, baseLines: 100 },
      { path: "src/billing/b.ts", removedLines: 0, baseLines: 20 },
    ];
    // 60 of 120 lines = 50%: at the limit, not past it.
    expect((await checkChanges(ctx, { changes })).verdict).toBe("warn");
    changes[1] = { path: "src/billing/b.ts", removedLines: 1, baseLines: 20 };
    const r = await checkChanges(ctx, { changes });
    expect(r.verdict).toBe("blocked");
    expect(r.findings[0]).toMatchObject({ rule: "protected-gutted" });
    expect(r.findings[0]?.message).toContain("51%");
    expect((await checkChanges(ctx, { changes, maxRemovalRatio: 0.9 })).verdict).toBe("warn");
  });

  it("a removal count larger than the file never pushes the share past 100%", async () => {
    const { ctx } = await setup();
    await billing(ctx);
    const r = await checkChanges(ctx, {
      changes: [
        { path: "src/billing/a.ts", removedLines: 500, baseLines: 10 },
        { path: "src/billing/b.ts", removedLines: 0, baseLines: 30 },
      ],
      maxRemovalRatio: 0.3,
    });
    // 10 of 40 = 25%, under 30%. Without the cap it would be 500/40.
    expect(r.verdict).toBe("warn");
  });
});

describe("checkChanges: other rules", () => {
  // PLAN: touching a shipped, unprotected feature warns.
  it("warns on shipped, unprotected features; ignores features not shipped", async () => {
    const { ctx } = await setup();
    const f = await billing(ctx, false);
    await createFeature(ctx, {
      title: "Draft",
      status: "planned",
      protected: true,
      paths: ["src/draft"],
    });
    const r = await checkChanges(ctx, {
      changes: [
        { path: "src/billing/a.ts", kind: "deleted" },
        { path: "src/draft/x.ts", kind: "deleted" },
      ],
    });
    expect(r).toEqual({
      verdict: "warn",
      findings: [expect.objectContaining({ rule: "shipped-touched", featureId: f.id })],
    });
  });

  // PLAN: touching a path exclusively locked by another actor is blocked.
  it("blocks paths in another agent's exclusive lock, warns on shared, ignores my own", async () => {
    const { ctx } = await setup();
    const other = await otherActor(ctx);
    const ex = await acquireLock(other, { paths: ["src/auth/**"] });
    await acquireLock(other, { paths: ["docs"], mode: "shared" });
    await acquireLock(ctx, { paths: ["lib"] });
    const r = await checkChanges(ctx, {
      changes: [{ path: "src/auth/login.ts" }, { path: "docs/a.md" }, { path: "lib/x.ts" }],
    });
    expect(r.verdict).toBe("blocked");
    expect(r.findings).toEqual([
      expect.objectContaining({ rule: "locked", lockId: ex.lock.id, paths: ["src/auth/login.ts"] }),
      expect.objectContaining({ level: "warn", rule: "locked-shared", paths: ["docs/a.md"] }),
    ]);
    expect(r.findings[0]?.message).toContain("codex@main#2");
  });

  it("is ok when nothing matches, and rejects paths outside the repo", async () => {
    const { ctx } = await setup();
    await billing(ctx);
    expect(await checkChanges(ctx, { changes: [{ path: "README.md" }] })).toEqual({
      verdict: "ok",
      findings: [],
    });
    await expect(checkChanges(ctx, { changes: [{ path: "../x" }] })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("recordGuard", () => {
  // PLAN: warnings write an activity entry; overrides are logged with the actor.
  it("logs one guard row per finding with the actor and the override flag", async () => {
    const { ctx, store } = await setup();
    const f = await billing(ctx);
    const other = await otherActor(ctx);
    const lock = await acquireLock(other, { paths: ["src/auth"] });
    const result = await checkChanges(ctx, {
      changes: [{ path: "src/billing/a.ts", kind: "deleted" }, { path: "src/auth/x.ts" }],
    });
    const before = store.activity.length;
    await recordGuard(ctx, result, { override: true });
    expect(store.activity.slice(before)).toEqual([
      expect.objectContaining({
        verb: "guard",
        entity: "lock",
        entityId: lock.lock.id,
        actorId: ctx.actorId,
      }),
      expect.objectContaining({
        verb: "guard",
        entity: "feature",
        entityId: f.id,
        diff: {
          rule: "protected-delete",
          level: "blocked",
          paths: ["src/billing/a.ts"],
          override: true,
        },
      }),
    ]);
  });

  // PLAN: a rename is not a delete. A move out of a shipped feature asks for a path update.
  it("warns when a rename leaves a shipped feature and does not block it as a delete", async () => {
    const { ctx } = await setup();
    const f = await billing(ctx);
    const r = await checkChanges(ctx, {
      changes: [{ path: "src/other/invoice.ts", kind: "renamed", from: "src/billing/invoice.ts" }],
    });
    expect(r.verdict).toBe("warn");
    expect(r.findings[0]).toMatchObject({ rule: "renamed-out", featureId: f.id });
    expect(r.findings[0]?.message).toContain(`feature update ${f.id}`);
  });

  it("treats a rename that stays inside the feature as a touch, not a deletion", async () => {
    const { ctx } = await setup();
    await billing(ctx);
    const r = await checkChanges(ctx, {
      changes: [{ path: "src/billing/new.ts", kind: "renamed", from: "src/billing/invoice.ts" }],
    });
    expect(r.verdict).toBe("warn");
    expect(r.findings[0]?.rule).toBe("shipped-touched");
  });

  it("writes nothing for a clean result", async () => {
    const { ctx, store } = await setup();
    const before = store.activity.length;
    await recordGuard(ctx, { verdict: "ok", findings: [] });
    expect(store.activity.length).toBe(before);
  });
});
