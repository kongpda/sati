import { describe, expect, it } from "vitest";
import {
  claimTask,
  completeTask,
  createFeature,
  createMilestone,
  createTask,
  detectSecret,
  markWaiting,
  recordDecision,
  refuseSecrets,
  type ServiceContext,
  scanRecord,
  updateFeature,
  updateMilestone,
  updateTask,
} from "../src/index.js";
import { setup } from "./support/setup.js";

// Fake secrets are built from pieces so this file itself never trips a secret scanner.
const fake = {
  aws: `AK${"IA"}${"ABCDEFGHIJ234567"}`,
  github: `gh${"p_"}${"a1".repeat(18)}`,
  githubPat: `github${"_pat_"}${"B2".repeat(15)}`,
  slack: `xo${"xb-"}1234567890-abcdef`,
  sk: `s${"k-"}ant-${"x9".repeat(15)}`,
  stripe: `s${"k_live_"}${"Q".repeat(24)}`,
  google: `AI${"za"}${"S".repeat(35)}`,
  jwt: `ey${"J"}hbGciOiJIUzI1.ey${"J"}zdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4`,
  pem: `-----BEGIN RSA ${"PRIVATE"} KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----`,
  env: `DATABASE_URL=postgres://db\nSTRIPE_SECRET=${"r".repeat(4)}9a8b7c6d`,
  url: `see postgres://admin:${"hunter"}22x@db.internal:5432/app`,
  npm: `np${"m_"}${"a1".repeat(18)}`,
  gitlab: `gl${"pat-"}${"Z9".repeat(10)}`,
};

describe("detectSecret", () => {
  // Why: every write runs this on the caller's thread. The `.env` pattern backtracked on a long
  // run of spaces, so one 100 KB note froze the process (and a shared `serve`) for many seconds.
  it("reads a line with a long run of spaces in linear time", () => {
    const line = `PAGE_TITLE=x${" ".repeat(100_000)}y z`;
    const started = performance.now();
    expect(detectSecret(line)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("still finds a .env secret followed by spaces", () => {
    expect(detectSecret("DB_PASSWORD=correct-horse-battery   \nnext line")).toBeDefined();
  });

  // PLAN Security: scan every exported record for API keys, tokens, private keys and .env lines.
  it.each(Object.entries(fake))("finds a %s secret inside prose", (_name, secret) => {
    expect(detectSecret(`Notes from today:\n${secret}\nthat is all`)).toBeDefined();
  });

  // False positives block commits, so ordinary task text must pass.
  it.each([
    "Rotate the API key before Friday",
    "token = getToken(); password = prompt()",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} reference is the input.
    "API_KEY=$API_KEY\nSECRET_TOKEN=${SECRET_TOKEN}\nPASSWORD=<your password>",
    "GITHUB_TOKEN=xxxxxxxxxxxx",
    "PRIMARY_KEY_COLUMN=id",
    "MAX_TOKENS=100000000\nPRIMARY_KEY=user_id_column\nSORT_KEY=created_at_desc",
    "Connect with postgres://user:password@localhost/app or https://$USER:$PASS@host",
    "Use sk-learn for the model; see task-1234",
    "-----BEGIN PUBLIC KEY-----",
  ])("passes ordinary text: %s", (text) => {
    expect(detectSecret(text)).toBeUndefined();
  });
});

describe("scanRecord", () => {
  it("names the entity, id and nested field, and never the secret", () => {
    const found = scanRecord("task", {
      id: "tsk_1",
      title: "ok",
      acceptance: ["fine", `token ${fake.github}`],
      meta: { deep: fake.aws },
    });
    expect(found).toEqual([
      { entity: "task", id: "tsk_1", field: "acceptance.1", kind: "GitHub token" },
      { entity: "task", id: "tsk_1", field: "meta.deep", kind: "AWS access key" },
    ]);
    expect(JSON.stringify(found)).not.toContain(fake.github);
  });
});

describe("refuseSecrets", () => {
  it("names the field and never the secret, and lets clean text through", () => {
    expect(() =>
      refuseSecrets("note", { title: "ok", body: "Rotate keys on Friday" }),
    ).not.toThrow();
    let err: unknown;
    try {
      refuseSecrets("note", { title: "ok", body: `see ${fake.stripe}` });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("in body") });
    expect(JSON.stringify(err) + String(err)).not.toContain(fake.stripe);
  });
});

// Review 1.1: a key in a task body used to be saved, shown in every brief, and then fail every
// later export. Every record that goes to .sati/ is refused at write time, as notes are.
describe("write-time refusal", () => {
  const key = fake.aws;
  const refused = { code: "VALIDATION" };

  async function count(ctx: ServiceContext) {
    const [tasks, decisions, features, milestones] = await Promise.all([
      ctx.store.read((r) => r.list("task", ctx.projectId, { limit: 500 })),
      ctx.store.read((r) => r.list("decision", ctx.projectId, { limit: 500 })),
      ctx.store.read((r) => r.list("feature", ctx.projectId, { limit: 500 })),
      ctx.store.read((r) => r.list("milestone", ctx.projectId, { limit: 500 })),
    ]);
    return {
      tasks: tasks.length,
      decisions: decisions.length,
      features: features.length,
      milestones: milestones.length,
    };
  }

  it("refuses a new record with a key in any free-text field, and saves nothing", async () => {
    const { ctx } = await setup();
    const before = await count(ctx);
    await expect(createTask(ctx, { title: "Deploy", body: `use ${key}` })).rejects.toMatchObject(
      refused,
    );
    // One bad subtask refuses the whole batch, parent included.
    await expect(
      createTask(ctx, { title: "Parent", subtasks: [{ title: "ok" }, { title: "x", body: key }] }),
    ).rejects.toMatchObject(refused);
    await expect(
      createTask(ctx, { title: "List", checklist: [{ text: `token ${key}`, done: false }] }),
    ).rejects.toMatchObject(refused);
    await expect(
      recordDecision(ctx, { title: "Auth", decision: "x", context: key }),
    ).rejects.toMatchObject(refused);
    await expect(createFeature(ctx, { title: "Login", acceptance: [key] })).rejects.toMatchObject(
      refused,
    );
    await expect(createMilestone(ctx, { title: "M1", goal: key })).rejects.toMatchObject(refused);
    expect(await count(ctx)).toEqual(before);
  });

  it("names the field and the kind, never the key", async () => {
    const { ctx } = await setup();
    const err = await createTask(ctx, { title: "Deploy", body: `use ${key}` }).catch((e) => e);
    expect(err.message).toContain("body");
    expect(JSON.stringify({ m: err.message, h: err.hint, d: err.details })).not.toContain(key);
  });

  it("refuses an update, a completion and a question, and leaves the record as it was", async () => {
    const { ctx } = await setup();
    const t = await createTask(ctx, { title: "Deploy" });
    await expect(updateTask(ctx, t.id, { body: key })).rejects.toMatchObject(refused);
    const held = await claimTask(ctx, t.id);
    const token = held.claim?.token;
    await expect(
      updateTask(ctx, t.id, { status: "blocked", reason: key, token }),
    ).rejects.toMatchObject(refused);
    await expect(
      markWaiting(ctx, { taskId: t.id, waiting: { text: `paste ${key}?` } }),
    ).rejects.toMatchObject(refused);
    await expect(
      completeTask(ctx, t.id, { summary: `done with ${key}`, token }),
    ).rejects.toMatchObject(refused);
    const now = await ctx.store.read((r) => r.get("task", t.id));
    expect(now?.version).toBe(held.version);
    expect(now?.status).toBe("in_progress");

    const f = await createFeature(ctx, { title: "Login" });
    await expect(updateFeature(ctx, f.id, { description: key })).rejects.toMatchObject(refused);
    const m = await createMilestone(ctx, { title: "M1" });
    await expect(updateMilestone(ctx, m.id, { title: key })).rejects.toMatchObject(refused);
    expect((await ctx.store.read((r) => r.get("feature", f.id)))?.version).toBe(f.version);
    expect((await ctx.store.read((r) => r.get("milestone", m.id)))?.version).toBe(m.version);
  });
});
