import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimTask,
  createIdFactory,
  createTask,
  ensureActor,
  initProject,
  markWaiting,
  systemClock,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { watchedSha256 } from "../src/file-hash.js";
import { createUiApp, listenUi, sessionToken } from "../src/ui/server.js";

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
  // As `sati ui` gives it: the board reads a file's hash to compare with the approved version.
  repo: { files: async () => [], head: async () => null, sha256: watchedSha256(dir) },
};
await createTask(ctx, { title: "Paint the board" });
const token = sessionToken();
const app = createUiApp({ ctx, root: dir }, token, dir);

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
    const guessed = await app.request(`http://127.0.0.1/session?token=${"x".repeat(token.length)}`);
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

  // PLAN Phase 5b: a browser with a stale session got raw JSON; a person needs to be told what
  // to do. The page is the only thing it gets: no board, no data, and a CSP as strict as before.
  it("shows a browser a plain page when its session is stale", async () => {
    const html = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };
    const stale = [
      await app.request("http://127.0.0.1/", { headers: html }),
      await app.request("http://127.0.0.1/features?task=tsk_1", {
        headers: { ...html, cookie: `sati_session_80=${token.slice(0, -1)}` },
      }),
      // An old sign-in link, from a `sati ui` that has since restarted with a new token.
      await app.request(`http://127.0.0.1/session?token=${"x".repeat(token.length)}`, {
        headers: html,
      }),
    ];
    for (const res of stale) {
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
      const page = await res.text();
      expect(page).toContain("This board link has expired");
      expect(page).toContain("sati ui</code> again");
      expect(page).not.toContain("<script");
      expect(page).not.toMatch(/(?:src|href)=/u);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toMatch(/style-src 'sha256-[\w+/=]+'/u);
      expect(csp).not.toContain("unsafe-inline");
    }
    // The checks before the session still come first.
    const foreign = await app.request("http://evil.test/", { headers: html });
    expect(foreign.status).toBe(403);
    const crossSite = await app.request("http://127.0.0.1/", {
      headers: { ...html, origin: "http://evil.test" },
    });
    expect(crossSite.status).toBe(403);
  });

  it("keeps a JSON 401 for API calls and the event stream, even when they accept HTML", async () => {
    for (const path of ["/api/snapshot", "/api/nothing-here", "/events"]) {
      for (const accept of ["application/json", "text/html,*/*"]) {
        const res = await app.request(`http://127.0.0.1${path}`, { headers: { accept } });
        expect(res.status).toBe(401);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("USAGE");
      }
    }
    const write = await app.request("http://127.0.0.1/api/tasks", {
      method: "POST",
      headers: { accept: "text/html", "content-type": "application/json" },
      body: JSON.stringify({ title: "No session" }),
    });
    expect(write.status).toBe(401);
    expect(write.headers.get("content-type")).toContain("application/json");
    // A script fetching a page without asking for HTML gets the JSON as before.
    const plain = await app.request("http://127.0.0.1/");
    expect(plain.status).toBe(401);
    expect(plain.headers.get("content-type")).toContain("application/json");
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

  // PLAN 9h: the board approves a file with the same hash `card approve` stores, so the guard
  // treats both alike; and it never reads a file outside the project folder.
  it("approves a project file by its hash, takes the approval away, and stays in the folder", async () => {
    const cookie = cookieOf(await app.request(`http://127.0.0.1/session?token=${token}`));
    const post = (body: unknown) =>
      app.request("http://127.0.0.1/api/cards/approve", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    mkdirSync(join(dir, "venue"));
    writeFileSync(join(dir, "venue", "quote.txt"), "price: 2400\n");
    const done = await post({ path: "venue/quote.txt" });
    expect(done.status).toBe(200);
    const card = (await done.json()) as { approved?: { hash: string; by: string } };
    expect(card.approved).toMatchObject({
      hash: createHash("sha256").update("price: 2400\n").digest("hex"),
      by: actor.id,
    });
    const snapshot = await app.request("http://127.0.0.1/api/snapshot", { headers: { cookie } });
    const { cards } = (await snapshot.json()) as { cards: { path: string; approved?: object }[] };
    expect(cards.find((c) => c.path === "venue/quote.txt")?.approved).toBeDefined();

    // The Memory page says when the file is no longer the approved one, with no commit needed.
    const approvalNow = async () => {
      const res = await app.request("http://127.0.0.1/api/snapshot", { headers: { cookie } });
      const body = (await res.json()) as { cards: { path: string; approval?: string }[] };
      return body.cards.find((c) => c.path === "venue/quote.txt")?.approval;
    };
    expect(await approvalNow()).toBe("kept");
    writeFileSync(join(dir, "venue", "quote.txt"), "price: 9900 and more\n");
    expect(await approvalNow()).toBe("changed");
    rmSync(join(dir, "venue", "quote.txt"));
    expect(await approvalNow()).toBe("missing");
    writeFileSync(join(dir, "venue", "quote.txt"), "price: 2400\n");
    expect(await approvalNow()).toBe("kept");

    const cleared = await post({ path: "venue/quote.txt", clear: true });
    expect(((await cleared.json()) as { approved?: object }).approved).toBeUndefined();

    expect((await post({ path: "venue/missing.txt" })).status).toBe(404);
    expect((await post({ path: "venue" })).status).toBe(404);
    for (const path of ["../outside.txt", "/etc/hosts"]) {
      expect((await post({ path })).status).toBe(400);
    }
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

  // Why: the snapshot version left out this server's own writes while the event stream counted
  // them, so UI queries keyed on data.version never refetched after a same-server write.
  it("bumps the snapshot version on a write made through this server", async () => {
    const cookie = cookieOf(await app.request(`http://127.0.0.1/session?token=${token}`));
    const version = async () =>
      (
        (await (
          await app.request("http://127.0.0.1/api/snapshot", { headers: { cookie } })
        ).json()) as { version: number }
      ).version;
    const before = await version();
    await app.request("http://127.0.0.1/api/tasks", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Bumps version" }),
    });
    expect(await version()).toBeGreaterThan(before);
  });

  // Why: a busy port surfaced as "This is a bug in sati".
  it("reports a busy port as a USAGE error with a hint", async () => {
    const first = await listenUi(app, 0);
    try {
      await expect(listenUi(app, first.port)).rejects.toMatchObject({
        code: "USAGE",
        message: `Port ${first.port} is already in use.`,
        hint: "Pick another with --port, or omit it for a free one.",
      });
    } finally {
      await first.close();
    }
  });

  // PLAN Phase 5c: a browser that reconnects with nothing missed is not told to refetch the board,
  // and one that missed a write is.
  it("resumes the event stream from Last-Event-ID", async () => {
    const cookie = cookieOf(await app.request(`http://127.0.0.1/session?token=${token}`));
    const open = async (lastEventId?: string) => {
      const headers: Record<string, string> = { cookie };
      if (lastEventId) headers["last-event-id"] = lastEventId;
      const res = await app.request("http://127.0.0.1/events", { headers });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no event stream");
      return async () => {
        const text = new TextDecoder().decode((await reader.read()).value);
        return { text, id: /^id: (\S+)$/m.exec(text)?.[1], stop: () => reader.cancel() };
      };
    };
    const first = await (await open())();
    expect(first.id).toMatch(/^act_/);
    await first.stop();

    // Nothing written since: the first message to arrive is the next write, not a replay.
    const quiet = await open(first.id);
    // Through the API, as another tab would; the server counts its own writes.
    await app.request("http://127.0.0.1/api/tasks", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "Written while connected" }),
    });
    const after = await quiet();
    expect(after.id).not.toBe(first.id);
    await after.stop();

    // A write while disconnected arrives at once, with the newer id.
    await createTask(ctx, { title: "Written while away" });
    const missed = await (await open(after.id))();
    expect(missed.id).not.toBe(after.id);
    await missed.stop();
  });

  // PLAN Phase 5c: the person answers an agent's question from the board.
  it("marks an agent's question answered without taking its claim", async () => {
    const agent = await ensureActor(ctx, { name: "codex@q", kind: "agent", tool: "codex" });
    const task = await createTask(ctx, { title: "Pick a colour" });
    const as = { ...ctx, actorId: agent.id };
    const claimed = await claimTask(as, task.id);
    await markWaiting(as, { taskId: task.id, waiting: { text: "Red or blue?" } });
    const cookie = cookieOf(await app.request(`http://127.0.0.1/session?token=${token}`));
    const res = await app.request(`http://127.0.0.1/api/tasks/${task.id}/answered`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      claim: { actorId: string; token: number; waiting?: unknown };
    };
    expect(body.claim).toMatchObject({ actorId: agent.id, token: claimed.claim?.token });
    expect(body.claim.waiting).toBeUndefined();
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
