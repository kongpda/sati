import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimTask,
  createIdFactory,
  createTask,
  ensureActor,
  initProject,
  systemClock,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createUiApp, sessionToken } from "../src/ui/server.js";

const dir = mkdtempSync(join(tmpdir(), "sati-ui-"));
const store = await SqliteStore.open(join(dir, "sati.db"));
const { project, actor } = await initProject(
  { store, clock: systemClock, ids: createIdFactory() },
  { slug: "ui", name: "UI" },
  { name: "tester", kind: "human" },
);
const ctx = {
  store,
  clock: systemClock,
  ids: createIdFactory(),
  projectId: project.id,
  actorId: actor.id,
  branch: "main",
};
await createTask(ctx, { title: "Paint the board" });
const token = sessionToken();
const app = createUiApp({ ctx }, token, dir);

afterAll(async () => {
  await store.close();
});

function cookieOf(res: Response): string {
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0] ?? "";
}

describe("ui server", () => {
  it("rejects a missing session, a foreign host and a foreign origin", async () => {
    const open = await app.request("http://127.0.0.1/api/snapshot");
    expect(open.status).toBe(401);
    const guessed = await app.request("http://127.0.0.1/session?token=" + "x".repeat(token.length));
    expect(guessed.status).toBe(401);
    const forged = await app.request("http://127.0.0.1/api/snapshot", {
      headers: { cookie: `sati_session_80=${token.slice(0, -1)}` },
    });
    expect(forged.status).toBe(401);

    const foreign = await app.request("http://evil.test/api/snapshot");
    expect(foreign.status).toBe(403);

    const session = await app.request(`http://127.0.0.1/session?token=${token}`);
    expect(session.status).toBe(302);
    const cookie = cookieOf(session);
    // The name carries the port (80 when the host has none), so two UIs do not share a cookie.
    expect(cookie.startsWith("sati_session_80=")).toBe(true);
    expect(session.headers.get("set-cookie")).toContain("HttpOnly");

    const wrongOrigin = await app.request("http://127.0.0.1/api/snapshot", {
      headers: { cookie, origin: "http://evil.test" },
    });
    expect(wrongOrigin.status).toBe(403);

    const snap = await app.request("http://127.0.0.1/api/snapshot", { headers: { cookie } });
    expect(snap.status).toBe(200);
    // PLAN Security: strict CSP with no inline scripts or styles, nosniff and no referrer.
    const csp = snap.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(snap.headers.get("x-content-type-options")).toBe("nosniff");
    expect(snap.headers.get("referrer-policy")).toBe("no-referrer");
    expect(session.headers.get("set-cookie")).toContain("SameSite=Strict");
    const body = (await snap.json()) as { tasks: { title: string }[] };
    expect(body.tasks.map((t) => t.title)).toEqual(["Paint the board"]);
  });

  // PLAN Security: request size limits. A huge body must be refused before it is parsed.
  it("refuses a request body over 1 MB", async () => {
    const session = await app.request(`http://127.0.0.1/session?token=${token}`);
    const res = await app.request("http://127.0.0.1/api/tasks", {
      method: "POST",
      headers: { cookie: cookieOf(session), "content-type": "application/json" },
      body: JSON.stringify({ title: "Big", body: "x".repeat(1024 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
  });

  // Why: bad JSON threw a bare parse error (500) and unknown /api paths fell through to the
  // static handler; clients need a JSON 400 / 404. The cookie name carries the port so two UIs
  // on one host do not overwrite each other's session.
  it("answers malformed JSON with 400, unknown API paths with 404, and names the cookie by port", async () => {
    const session = await app.request(`http://127.0.0.1:4321/session?token=${token}`);
    const set = session.headers.get("set-cookie") ?? "";
    expect(set.startsWith("sati_session_4321=")).toBe(true);
    const cookie = set.split(";")[0] ?? "";
    const bad = await app.request("http://127.0.0.1:4321/api/tasks", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{nope",
    });
    expect(bad.status).toBe(400);
    const missing = await app.request("http://127.0.0.1:4321/api/nothing-here", {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  // PLAN: live updates under 500 ms. A write made through this server must reach other tabs.
  it("tells the event stream about a write made through this server", async () => {
    const cookie = cookieOf(await app.request(`http://127.0.0.1/session?token=${token}`));
    const events = await app.request("http://127.0.0.1/events", { headers: { cookie } });
    const reader = events.body?.getReader();
    if (!reader) throw new Error("no event stream");
    const next = async () => new TextDecoder().decode((await reader.read()).value);
    const first = await next();
    await app.request("http://127.0.0.1/api/tasks", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "From another tab" }),
    });
    const second = await next();
    await reader.cancel();
    expect(second).not.toBe(first);
  });

  // PLAN Phase 5b: the person at the board takes over an agent's task, then edits it.
  it("takes over an agent's claim and saves edits with the person's own token", async () => {
    const agent = await ensureActor(ctx, { name: "codex@b", kind: "agent", tool: "codex" });
    const task = await createTask(ctx, { title: "Book the venue" });
    await claimTask({ ...ctx, actorId: agent.id }, task.id);
    const cookie = cookieOf(await app.request(`http://127.0.0.1/session?token=${token}`));
    const post = (path: string, payload: unknown, method = "POST") =>
      app.request(`http://127.0.0.1${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    // Without the claim's token the edit is refused, as before.
    expect((await post(`/api/tasks/${task.id}`, { body: "x" }, "PATCH")).status).toBe(409);
    const taken = await post(`/api/tasks/${task.id}/take-over`, {});
    expect(taken.status).toBe(200);
    expect(((await taken.json()) as { claim: { actorId: string } }).claim.actorId).toBe(actor.id);
    expect((await post(`/api/tasks/${task.id}`, { body: "Hall B" }, "PATCH")).status).toBe(200);
    const released = await post(`/api/tasks/${task.id}/release`, { force: false });
    expect(((await released.json()) as { status: string }).status).toBe("todo");
  });

  it("deletes a note softly, hides it from the board, and restores it", async () => {
    const cookie = cookieOf(await app.request(`http://127.0.0.1/session?token=${token}`));
    const call = (path: string, method: string, payload?: unknown) =>
      app.request(`http://127.0.0.1${path}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    const titles = async () =>
      (
        (await (await call("/api/snapshot", "GET")).json()) as { notes: { title: string }[] }
      ).notes.map((n) => n.title);
    const note = (await (await call("/api/notes", "POST", { title: "Venue list" })).json()) as {
      id: string;
    };
    expect((await call(`/api/notes/${note.id}`, "DELETE")).status).toBe(200);
    expect(await titles()).not.toContain("Venue list");
    // Deleting twice is a 404, so a double click cannot log two deletes.
    expect((await call(`/api/notes/${note.id}`, "DELETE")).status).toBe(404);
    expect((await call(`/api/notes/${note.id}/restore`, "POST", {})).status).toBe(200);
    expect(await titles()).toContain("Venue list");
    const comment = await call("/api/comments", "POST", { on: note.id, body: "Add the prices" });
    expect(comment.status).toBe(200);
    expect(await comment.json()).toMatchObject({ tags: ["comment"], links: [note.id] });
    expect((await call("/api/comments", "POST", { on: note.id, body: " " })).status).toBe(400);
    // Milestones are not deletable here.
    expect((await call("/api/milestones/mil_x", "DELETE")).status).toBe(404);
  });
});
