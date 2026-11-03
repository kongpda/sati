import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createFeature,
  createIdFactory,
  ensureActor,
  fixedClock,
  initProject,
  type ServiceContext,
  shortHandle,
  WORKFLOW,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

let dir: string;
let store: SqliteStore;
let ctx: ServiceContext;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "sati-mcp-"));
  store = await SqliteStore.open(join(dir, "sati.db"));
  const clock = fixedClock("2026-11-03T12:00:00.000Z");
  const ids = createIdFactory(() => clock.now().getTime());
  const { project, actor } = await initProject(
    { store, clock, ids },
    { slug: "demo", name: "Demo" },
    { name: "claude-code@main#1", kind: "agent", tool: "claude-code" },
  );
  ctx = { store, clock, ids, projectId: project.id, actorId: actor.id, branch: "main" };
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(as: ServiceContext = ctx): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(as).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

/** Calls a tool and returns its parsed JSON payload plus the error flag. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  return { isError: res.isError === true, body: JSON.parse(content[0]?.text ?? "null") };
}

describe("MCP server", () => {
  it("exposes the agent tools, resources and prompts", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual([
      "context_get",
      "context_put",
      "decision_record",
      "feature_check",
      "feature_upsert",
      "lock_acquire",
      "lock_release",
      "sati_brief",
      "search",
      "task_claim",
      "task_complete",
      "task_create",
      "task_list",
      "task_update",
    ]);
    const resources = (await client.listResources()).resources.map((r) => r.uri);
    expect(resources).toEqual(["sati://workflow", "sati://project/roadmap"]);
    const templates = (await client.listResourceTemplates()).resourceTemplates;
    expect(templates.map((t) => t.uriTemplate)).toEqual(["sati://feature/{id}"]);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(["finish-task", "plan-feature", "start-task"]);
  });

  // The gate: an agent finishes a real task end to end using only sati tools.
  it("runs a task from create through claim and update to complete, by short handle", async () => {
    const client = await connect();
    const created = await call(client, "task_create", { title: "Add login", priority: "high" });
    expect(created.isError).toBe(false);
    const handle = shortHandle(created.body.id);

    const ready = await call(client, "task_list", { ready: true });
    expect(ready.body.map((t: { id: string }) => t.id)).toEqual([created.body.id]);

    const claimed = await call(client, "task_claim", { id: handle });
    expect(claimed.body).toMatchObject({ status: "in_progress", claim: { actorId: ctx.actorId } });
    const token = claimed.body.claim.token;
    expect(token).toEqual(expect.any(Number));

    // PLAN review fix 2: writes on a claimed task must present the claim's fencing token.
    const noToken = await call(client, "task_update", { id: handle, body: "halfway" });
    expect(noToken).toMatchObject({ isError: true, body: { error: { code: "CONFLICT" } } });
    const updated = await call(client, "task_update", { id: handle, body: "halfway", token });
    expect(updated.body.body).toBe("halfway");

    const done = await call(client, "task_complete", {
      id: handle,
      summary: "Login form and session cookie",
      filesTouched: ["src/login.ts"],
      token,
    });
    expect(done.body).toMatchObject({ status: "done", claim: null });

    const activity = await store.read((r) => r.listActivity(ctx.projectId));
    const verbs = activity.filter((a) => a.entityId === created.body.id).map((a) => a.verb);
    expect(verbs.sort()).toEqual(["claim", "complete", "create", "update"]);
  });

  // Two agents must never hold one task; the loser needs the holder's name to coordinate.
  // The agent decides what to do with a likely duplicate; the tool only has to show it.
  it("lists likely duplicates when creating a task, but never the new task itself", async () => {
    const client = await connect();
    const first = await call(client, "task_create", { title: "Fix login redirect loop" });
    expect(first.body.similar).toEqual([]);
    const second = await call(client, "task_create", { title: "Login redirect loop after OAuth" });
    expect(second.isError).toBe(false);
    expect(second.body.similar).toEqual([
      expect.objectContaining({ id: shortHandle(first.body.id), status: "todo" }),
    ]);
  });

  it("returns a CONFLICT tool error naming the holder when another agent claims", async () => {
    const first = await connect();
    const task = await call(first, "task_create", { title: "x" });
    await call(first, "task_claim", { id: task.body.id });

    const codex = await ensureActor(ctx, { name: "codex@main#2", kind: "agent", tool: "codex" });
    const second = await connect({ ...ctx, actorId: codex.id });
    const res = await call(second, "task_claim", { id: task.body.id });
    expect(res.isError).toBe(true);
    expect(res.body.error).toMatchObject({ code: "CONFLICT" });
    expect(res.body.error.message).toContain("claude-code@main#1");
  });

  // Locks only help if a second agent, in its own session, is actually refused.
  it("locks paths against another agent until the holder releases them", async () => {
    const first = await connect();
    const task = await call(first, "task_create", { title: "Billing" });
    const lock = await call(first, "lock_acquire", {
      paths: ["./src/billing/"],
      taskId: shortHandle(task.body.id),
      reason: "refactor",
    });
    expect(lock.isError).toBe(false);
    expect(lock.body.lock).toMatchObject({ paths: ["src/billing"], mode: "exclusive" });

    const codex = await ensureActor(ctx, { name: "codex@main#2", kind: "agent", tool: "codex" });
    const second = await connect({ ...ctx, actorId: codex.id });
    const refused = await call(second, "lock_acquire", { paths: ["src/billing/**"] });
    expect(refused.body.error).toMatchObject({ code: "CONFLICT" });
    expect(refused.body.error.message).toContain("claude-code@main#1");
    expect((await call(second, "lock_release", { id: lock.body.lock.id })).isError).toBe(true);

    const released = await call(first, "lock_release", { id: shortHandle(lock.body.lock.id) });
    expect(released.body.deletedAt).not.toBeNull();
    expect((await call(second, "lock_acquire", { paths: ["src/billing/**"] })).isError).toBe(false);
  });

  it("reports validation failures as tool errors instead of crashing", async () => {
    const client = await connect();
    const bad = await client.callTool({
      name: "task_complete",
      arguments: { id: "tsk_000000", summary: "x" },
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain("filesTouched");
    // Input that passes the schema but fails in core keeps the code and hint.
    const missing = await call(client, "task_claim", { id: "tsk_000000" });
    expect(missing.body.error).toMatchObject({ code: "NOT_FOUND", hint: expect.any(String) });
  });

  it("creates a feature without an id and updates it with one", async () => {
    const client = await connect();
    const created = await call(client, "feature_upsert", {
      title: "Login",
      paths: ["src/login/**"],
    });
    expect(created.body).toMatchObject({ title: "Login", status: "planned" });
    const updated = await call(client, "feature_upsert", {
      id: created.body.id,
      status: "building",
      protected: true,
    });
    expect(updated.body).toMatchObject({
      id: created.body.id,
      status: "building",
      protected: true,
    });
  });

  it("records decisions and finds them with search", async () => {
    const client = await connect();
    const dec = await call(client, "decision_record", {
      title: "Use cookies for sessions",
      decision: "Signed httpOnly cookies, not localStorage tokens.",
    });
    expect(dec.isError).toBe(false);
    const hits = await call(client, "search", { query: "cookies" });
    expect(hits.body.map((h: { id: string }) => h.id)).toEqual([dec.body.id]);
  });

  it("serves the workflow, the roadmap and a feature with its tasks", async () => {
    const client = await connect();
    const workflow = await client.readResource({ uri: "sati://workflow" });
    expect(workflow.contents[0]).toMatchObject({ text: WORKFLOW });

    const feat = await call(client, "feature_upsert", { title: "Login" });
    await call(client, "task_create", { title: "Form", featureId: feat.body.id });

    const roadmap = await client.readResource({ uri: "sati://project/roadmap" });
    const text = (roadmap.contents[0] as { text: string }).text;
    expect(text).toContain("# Demo roadmap");
    expect(text).toContain(`${shortHandle(feat.body.id)} Login (planned)`);

    const one = await client.readResource({ uri: `sati://feature/${shortHandle(feat.body.id)}` });
    const body = JSON.parse((one.contents[0] as { text: string }).text);
    expect(body.feature.id).toBe(feat.body.id);
    expect(body.tasks).toEqual([expect.objectContaining({ title: "Form", status: "todo" })]);
  });

  it("returns the brief as Markdown, listing the task the agent claimed", async () => {
    const client = await connect();
    const t = await call(client, "task_create", { title: "Ship it" });
    await call(client, "task_claim", { id: t.body.id });
    const res = await client.callTool({ name: "sati_brief", arguments: {} });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    expect(text).toMatch(/^# sati brief: Demo/);
    expect(text).toContain(`${shortHandle(t.body.id)} [in_progress, medium] Ship it`);
  });

  // AGENTS.md rule 3: agents call feature_check before deleting code, and stop when blocked.
  it("feature_check blocks deleting a shipped, protected feature's file", async () => {
    const client = await connect();
    await createFeature(ctx, {
      title: "Billing",
      status: "shipped",
      protected: true,
      paths: ["src/billing/**"],
    });
    const del = await call(client, "feature_check", {
      paths: ["src/billing/a.ts"],
      change: "delete",
    });
    expect(del.body).toMatchObject({
      verdict: "blocked",
      findings: [{ rule: "protected-delete" }],
    });
    const edit = await call(client, "feature_check", { paths: ["src/billing/a.ts"] });
    expect(edit.body.verdict).toBe("warn");
  });

  // PLAN: context_get flags stale entries by hash, so agents re-read only changed modules.
  it("saves context and flags it stale when the module's files change", async () => {
    let blob = "a1";
    const repo = {
      files: async () => [{ path: "src/auth/login.ts", blob }],
      head: async () => "c0ffee",
    };
    const client = await connect({ ...ctx, repo });
    const put = await call(client, "context_put", { path: "src/auth", summary: "Login flow" });
    expect(put).toMatchObject({ isError: false, body: { path: "src/auth", gitCommit: "c0ffee" } });
    expect((await call(client, "context_get", {})).body).toEqual([
      expect.objectContaining({ path: "src/auth", stale: false }),
    ]);
    blob = "a2";
    expect((await call(client, "context_get", { path: "src/auth/login.ts" })).body).toEqual([
      expect.objectContaining({ stale: true }),
    ]);
  });

  it("fills prompt arguments into the instructions", async () => {
    const client = await connect();
    const res = await client.getPrompt({ name: "start-task", arguments: { taskId: "tsk_abc123" } });
    const msg = res.messages[0]?.content as { text: string };
    expect(msg.text).toContain("task_claim with id tsk_abc123");
  });
});
