import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory, createTask, initProject, systemClock } from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(async () => {
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
});
