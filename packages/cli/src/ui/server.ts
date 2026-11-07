import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  CLI_NAME,
  createMilestone,
  createNote,
  createTask,
  isSatiError,
  recordDecision,
  releaseExpiredClaims,
  SatiError,
  type ServiceContext,
  type StorageAdapter,
  updateFeature,
  updateMilestone,
  updateNote,
  updateTask,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import micromatch from "micromatch";

/**
 * Cookies are shared by every port on 127.0.0.1, so two `sati ui` servers would overwrite each
 * other's session under one name. The name carries the port the request came in on.
 */
const cookieName = (host: string) => `sati_session_${host.split(":")[1] ?? "80"}`;
const hostOf = (c: Context) => c.req.header("host") ?? new URL(c.req.url).host;
/** Largest request body the API reads. Records are capped at 100 KB, so this is generous. */
const MAX_BODY_BYTES = 1024 * 1024;

/** Compares in constant time, so response timing does not reveal how much of a guess matched. */
function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

export interface UiRuntime {
  ctx: ServiceContext;
  /** The store `data_version` is read from, when `ctx.store` is a wrapper around it. */
  dataStore?: StorageAdapter;
}

/** A JSON request body. Malformed JSON is the client's mistake: 400, not a 500 "server failed". */
async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new SatiError("USAGE", "The request body is not valid JSON.");
  }
}

function httpStatus(code: string): 400 | 404 | 409 | 500 {
  if (code === "NOT_FOUND") return 404;
  if (code === "CONFLICT" || code === "INVALID_TRANSITION") return 409;
  if (code === "VALIDATION" || code === "USAGE") return 400;
  return 500;
}

function dataVersion(rt: UiRuntime): number {
  const store = rt.dataStore ?? rt.ctx.store;
  if (!(store instanceof SqliteStore)) return 0;
  return Number(store.db.pragma("data_version", { simple: true }));
}

function openApi() {
  return {
    openapi: "3.1.0",
    info: { title: `${CLI_NAME} local ui`, version: "0.0.0" },
    paths: {
      "/api/snapshot": { get: { summary: "Board payload" } },
      "/api/search": {
        get: { summary: "Full-text search", parameters: [{ name: "q", in: "query" }] },
      },
      "/api/tasks": { post: { summary: "Create a task" } },
      "/api/tasks/{id}": { patch: { summary: "Update a task" } },
      "/api/claims/release-expired": { post: { summary: "Release expired claims" } },
      "/api/notes": { post: { summary: "Create a note" } },
      "/api/notes/{id}": { patch: { summary: "Update a note" } },
      "/api/decisions": { post: { summary: "Record a decision" } },
      "/api/features/{id}": { patch: { summary: "Update a feature" } },
      "/api/milestones": { post: { summary: "Create a milestone" } },
      "/api/milestones/{id}": { patch: { summary: "Update a milestone" } },
      "/events": { get: { summary: "Server-sent events when the database changes" } },
    },
  };
}

async function every<T>(load: (offset: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const page = await load(offset);
    out.push(...page);
    if (page.length < 500) break;
  }
  return out;
}

/** One payload for the board. The browser refetches it when the database version changes. */
async function snapshot(rt: UiRuntime) {
  const { ctx } = rt;
  const now = new Date().toISOString();
  const page = { limit: 500 } as const;
  const loaded = await ctx.store.read(async (r) => {
    const tasks = await every((offset) => r.list("task", ctx.projectId, { ...page, offset }));
    const features = await every((offset) => r.list("feature", ctx.projectId, { ...page, offset }));
    const notes = await every((offset) =>
      r.list("note", ctx.projectId, { ...page, offset, newestFirst: true }),
    );
    const decisions = await every((offset) =>
      r.list("decision", ctx.projectId, { ...page, offset, newestFirst: true }),
    );
    const actors = await every((offset) => r.list("actor", ctx.projectId, { ...page, offset }));
    const milestones = await every((offset) =>
      r.list("milestone", ctx.projectId, { ...page, offset }),
    );
    const activity = await r.listActivity(ctx.projectId, { limit: 200 });
    const locks = await every((offset) => r.list("lock", ctx.projectId, { ...page, offset }));
    return {
      tasks,
      features,
      notes,
      decisions,
      actors,
      milestones,
      activity,
      locks: locks.filter((lock) => lock.leaseUntil > now),
    };
  });
  const { tasks, features, notes, decisions, actors, milestones, activity, locks } = loaded;
  const files = ctx.repo ? (await ctx.repo.files()).map((f) => f.path) : [];
  const featuresWithMatches = features.map((f) => {
    const matchCount =
      files.length === 0
        ? null
        : files.filter((file) => micromatch.isMatch(file, f.paths, { dot: true })).length;
    return { ...f, matchCount };
  });
  const project = await ctx.store.read((r) => r.getProject());
  return {
    project: project ? { id: project.id, name: project.name, slug: project.slug } : null,
    you: ctx.actorId,
    version: dataVersion(rt),
    tasks,
    features: featuresWithMatches,
    notes,
    decisions,
    actors,
    milestones,
    activity,
    locks,
  };
}

export function createUiApp(rt: UiRuntime, token: string, uiDir: string): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const host = hostOf(c);
    const hostname = host.split(":")[0];
    if (hostname !== "127.0.0.1" && hostname !== "localhost") {
      return c.text("This server only answers on localhost.", 403);
    }
    const origin = c.req.header("origin");
    if (origin && origin !== `http://${host}`) return c.text("Cross-site request refused.", 403);
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
  });

  app.onError((err, c) => {
    if (isSatiError(err)) {
      return c.json(
        { error: { code: err.code, message: err.message, hint: err.hint ?? null } },
        httpStatus(err.code),
      );
    }
    return c.json({ error: { code: "INTERNAL", message: "The server failed.", hint: null } }, 500);
  });

  app.get("/session", (c) => {
    if (!sameToken(c.req.query("token"), token)) return c.text("Sign-in token refused.", 401);
    setCookie(c, cookieName(hostOf(c)), token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure: false,
    });
    return c.redirect("/");
  });

  app.use("*", async (c, next) => {
    if (sameToken(getCookie(c, cookieName(hostOf(c))), token)) return next();
    return c.json(
      { error: { code: "USAGE", message: `Open this board from \`${CLI_NAME} ui\`.`, hint: null } },
      401,
    );
  });

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          { error: { code: "VALIDATION", message: "The request body is over 1 MB.", hint: null } },
          413,
        ),
    }),
  );

  app.get("/api/openapi.json", (c) => c.json(openApi()));
  app.get("/api/snapshot", async (c) => c.json(await snapshot(rt)));

  app.get("/api/search", async (c) => {
    const q = c.req.query("q") ?? "";
    const hits = await rt.ctx.store.read((r) => r.search(rt.ctx.projectId, q, { limit: 20 }));
    return c.json({ hits });
  });

  app.post("/api/tasks", async (c) => c.json(await createTask(rt.ctx, await body(c))));
  app.patch("/api/tasks/:id", async (c) =>
    c.json(await updateTask(rt.ctx, c.req.param("id"), await body(c))),
  );
  app.post("/api/claims/release-expired", async (c) => c.json(await releaseExpiredClaims(rt.ctx)));

  app.post("/api/notes", async (c) => c.json(await createNote(rt.ctx, await body(c))));
  app.patch("/api/notes/:id", async (c) =>
    c.json(await updateNote(rt.ctx, c.req.param("id"), await body(c))),
  );

  app.post("/api/decisions", async (c) => c.json(await recordDecision(rt.ctx, await body(c))));

  app.patch("/api/features/:id", async (c) =>
    c.json(await updateFeature(rt.ctx, c.req.param("id"), await body(c))),
  );

  app.post("/api/milestones", async (c) => c.json(await createMilestone(rt.ctx, await body(c))));
  app.patch("/api/milestones/:id", async (c) =>
    c.json(await updateMilestone(rt.ctx, c.req.param("id"), await body(c))),
  );

  // An unknown API path is a 404, not the SPA page with a 200 that a client would try to parse.
  app.all("/api/*", (c) =>
    c.json({ error: { code: "NOT_FOUND", message: "No such API path.", hint: null } }, 404),
  );

  app.get("/events", () => {
    let last = dataVersion(rt);
    let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const send = (chunk: string) => controller.enqueue(new TextEncoder().encode(chunk));
        send(`data: ${JSON.stringify({ version: last })}\n\n`);
        timer = setInterval(() => {
          const version = dataVersion(rt);
          if (version === last) return;
          last = version;
          send(`data: ${JSON.stringify({ version })}\n\n`);
        }, 250);
      },
      cancel() {
        if (timer) clearInterval(timer);
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  });

  app.use("/*", serveStatic({ root: uiDir }));
  app.get("*", serveStatic({ root: uiDir, path: "index.html" }));
  return app;
}

export function sessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Listens on 127.0.0.1 only. Port 0 picks a free port. */
export function listenUi(
  app: Hono,
  port = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            (server as Server).close((err) => (err ? fail(err) : done()));
            // Open event streams and keep-alive sockets would hold close() open forever.
            (server as Server).closeAllConnections();
          }),
      });
    });
  });
}
