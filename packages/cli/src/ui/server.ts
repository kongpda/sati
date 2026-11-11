import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  addComment,
  applyTemplate,
  approveCard,
  availableTemplates,
  CLI_NAME,
  createMilestone,
  createNote,
  createTask,
  deleteRecord,
  featureList,
  formatChanges,
  getContext,
  isSatiError,
  listChanges,
  markWaiting,
  ProjectKind,
  parseInput,
  putContext,
  RepoPath,
  readSettings,
  recall,
  recordDecision,
  releaseExpiredClaims,
  releaseTask,
  restoreRecord,
  reviewDrift,
  SatiError,
  type ServiceContext,
  type StorageAdapter,
  summarize,
  type TemplateFile,
  takeOverTask,
  updateFeature,
  updateMilestone,
  updateNote,
  updateProfile,
  updateSettings,
  updateTask,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import micromatch from "micromatch";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { fileSha256 } from "../file-hash.js";

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

const STALE_STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:15vh auto;padding:0 1.25rem}" +
  "code{font-size:1.05em;padding:0 .25em;border:1px solid #8888;border-radius:4px}";
/** The page's own policy: the same, but its one inline style is allowed by hash. */
const STALE_CSP = CSP.replace(
  "style-src 'self'",
  `style-src 'sha256-${createHash("sha256").update(STALE_STYLE).digest("base64")}'`,
);
/** What a browser gets when its session is gone: the server restarted or the link is old. */
const STALE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>This board link has expired</title>
<style>${STALE_STYLE}</style>
</head>
<body>
<h1>This board link has expired</h1>
<p>The board opens only from the link that <code>${CLI_NAME} ui</code> prints, and each link stops working when <code>${CLI_NAME} ui</code> stops or starts again.</p>
<p>To get a new link, run <code>${CLI_NAME} ui</code> again in your project folder.</p>
</body>
</html>
`;

/** A browser opening a page, not the board's own API calls or event stream. */
function wantsPage(c: Context): boolean {
  const path = c.req.path;
  if (path.startsWith("/api/") || path === "/api" || path === "/events") return false;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return false;
  return c.req.header("accept")?.includes("text/html") ?? false;
}

function stalePage(c: Context): Response {
  c.header("Content-Security-Policy", STALE_CSP);
  c.header("Cache-Control", "no-store");
  return c.html(STALE_PAGE, 401);
}

export interface UiRuntime {
  ctx: ServiceContext;
  /** The store `data_version` is read from, when `ctx.store` is a wrapper around it. */
  dataStore?: StorageAdapter;
  /** Called after the project kind changes, to record it in the committed config. */
  onKind?: (kind: ProjectKind) => void;
  /** The project's own templates (`.sati/templates/`); without it, only the starters. */
  templates?: () => TemplateFile[];
  /** The project folder. Approving a file hashes it there; without it, no file can be approved. */
  root?: string;
}

const ApproveBody = z.strictObject({ path: RepoPath, clear: z.boolean().optional() });

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
  return store.dataVersion();
}

function openApi() {
  return {
    openapi: "3.1.0",
    info: { title: `${CLI_NAME} local ui`, version: pkg.version },
    paths: {
      "/api/snapshot": { get: { summary: "Board payload" } },
      "/api/search": {
        get: { summary: "Full-text search", parameters: [{ name: "q", in: "query" }] },
      },
      "/api/changes": {
        get: {
          summary: "What changed (query: since, milestoneId, actorId), with changelog and digest",
        },
      },
      "/api/feature-list": { get: { summary: "Shipped features as Markdown" } },
      "/api/recall": { get: { summary: "What is known about a question (query: q)" } },
      "/api/cards": { post: { summary: "Save a card (replaces the card for its path)" } },
      "/api/cards/approve": {
        post: { summary: "Approve a file as it is now, or take the approval away" },
      },
      "/api/templates": { get: { summary: "Plan templates: the starters and .sati/templates/" } },
      "/api/templates/apply": { post: { summary: "Create a milestone and its tasks from one" } },
      "/api/tasks": { post: { summary: "Create a task" } },
      "/api/tasks/{id}": { patch: { summary: "Update a task" }, delete: { summary: "Delete" } },
      "/api/tasks/{id}/restore": { post: { summary: "Restore a deleted task" } },
      "/api/tasks/{id}/release": { post: { summary: "Release a claim (force: people only)" } },
      "/api/tasks/{id}/take-over": { post: { summary: "Take a task over (people only)" } },
      "/api/tasks/{id}/answered": {
        post: { summary: "A person answered: the agent stops waiting on them" },
      },
      "/api/claims/release-expired": { post: { summary: "Release expired claims" } },
      "/api/notes": { post: { summary: "Create a note" } },
      "/api/comments": { post: { summary: "Comment on a task, note or decision" } },
      "/api/notes/{id}": { patch: { summary: "Update a note" }, delete: { summary: "Delete" } },
      "/api/notes/{id}/restore": { post: { summary: "Restore a deleted note" } },
      "/api/decisions": { post: { summary: "Record a decision" } },
      "/api/decisions/{id}": { delete: { summary: "Delete a decision" } },
      "/api/decisions/{id}/restore": { post: { summary: "Restore a deleted decision" } },
      "/api/features/{id}": { patch: { summary: "Update a feature" } },
      "/api/milestones": { post: { summary: "Create a milestone" } },
      "/api/milestones/{id}": { patch: { summary: "Update a milestone" } },
      "/api/actors/{id}": { patch: { summary: "Set a person's display name, initials, colour" } },
      "/api/settings": { patch: { summary: "Set the project kind: code or general" } },
      "/events": {
        get: {
          summary: "Server-sent events when the database changes; resumes with Last-Event-ID",
        },
      },
    },
  };
}

/** Most records of one kind the board loads; the rest are named in `truncated`. */
const SNAPSHOT_CAP = 5000;

/** Pages through a list up to SNAPSHOT_CAP, noting in `cut` when there was more. */
async function every<T>(
  name: string,
  cut: string[],
  load: (offset: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < SNAPSHOT_CAP; offset += 500) {
    const page = await load(offset);
    out.push(...page);
    if (page.length < 500) return out;
  }
  if ((await load(SNAPSHOT_CAP)).length > 0) cut.push(name);
  return out;
}

/** The first call's promise, reused by every later call. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | undefined;
  return () => {
    kept ??= load();
    return kept;
  };
}

/** One payload for the board. The browser refetches it when the database version changes. */
async function snapshot(rt: UiRuntime, version: () => number) {
  const { ctx } = rt;
  const now = new Date().toISOString();
  const page = { limit: 500 } as const;
  // Kinds that had more records than the board loads, so it can say so instead of hiding them.
  const truncated: string[] = [];
  const loaded = await ctx.store.read(async (r) => {
    const tasks = await every("tasks", truncated, (offset) =>
      r.list("task", ctx.projectId, { ...page, offset }),
    );
    const features = await every("features", truncated, (offset) =>
      r.list("feature", ctx.projectId, { ...page, offset }),
    );
    const notes = await every("notes", truncated, (offset) =>
      r.list("note", ctx.projectId, { ...page, offset, newestFirst: true }),
    );
    const decisions = await every("decisions", truncated, (offset) =>
      r.list("decision", ctx.projectId, { ...page, offset, newestFirst: true }),
    );
    const actors = await every("people", truncated, (offset) =>
      r.list("actor", ctx.projectId, { ...page, offset }),
    );
    const milestones = await every("plans", truncated, (offset) =>
      r.list("milestone", ctx.projectId, { ...page, offset }),
    );
    const activity = await r.listActivity(ctx.projectId, { limit: 200 });
    const locks = await every("locks", truncated, (offset) =>
      r.list("lock", ctx.projectId, { ...page, offset }),
    );
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
  // Listing files walks the folder (or runs git, blocking): once per snapshot, shared by the
  // feature match counts and the cards' staleness.
  const listed = ctx.repo ? once(ctx.repo.files) : undefined;
  const local = listed && ctx.repo ? { ...ctx, repo: { ...ctx.repo, files: listed } } : ctx;
  const files = listed && features.length > 0 ? (await listed()).map((f) => f.path) : [];
  const featuresWithMatches = features.map((f) => {
    if (files.length === 0) return { ...f, matchCount: null };
    // One compiled matcher per glob, not a parse per file; any glob matching counts, as in isMatch.
    const matchers = f.paths.map((glob) => micromatch.matcher(glob, { dot: true }));
    return { ...f, matchCount: files.filter((file) => matchers.some((m) => m(file))).length };
  });
  const project = await ctx.store.read((r) => r.getProject());
  // Cards with their git staleness; read after the snapshot, as the brief does.
  const cards = await getContext(local);
  // Work waiting for approval whose branch moved on since it was sent, so a person looks again.
  const drift = Object.fromEntries(
    await reviewDrift(
      local,
      tasks.filter((t) => t.status === "review"),
    ),
  );
  return {
    project: project
      ? {
          id: project.id,
          name: project.name,
          slug: project.slug,
          kind: readSettings(project.settings).kind,
          // The board hides Approve from an agent only while the gate is on.
          review: readSettings(project.settings).review,
        }
      : null,
    you: ctx.actorId,
    version: version(),
    truncated,
    tasks,
    features: featuresWithMatches,
    notes,
    decisions,
    actors,
    milestones,
    activity,
    locks,
    cards,
    drift,
  };
}

/**
 * The newest activity row in commit order: the newest by time, then every row committed after it
 * (a process with a slow clock writes rows that sort earlier but commit later).
 */
async function tailCursor(rt: UiRuntime, from?: string): Promise<string | undefined> {
  const { ctx } = rt;
  return ctx.store.read(async (r) => {
    let cursor = from ?? (await r.listActivity(ctx.projectId, { limit: 1 }))[0]?.id;
    for (let page = 0; cursor && page < 20; page++) {
      const rows = await r.listActivity(ctx.projectId, { after: cursor, limit: 500 });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1]?.id ?? cursor;
    }
    return cursor;
  });
}

/** An activity id as SSE sends it back in Last-Event-ID; anything else is ignored. */
const ActivityCursor = z.string().regex(/^act_[0-9A-HJKMNP-TV-Z]{26}$/);

const SearchQuery = z.string().max(500);
const SettingsPatch = z.strictObject({ kind: ProjectKind });

export function createUiApp(rt: UiRuntime, token: string, uiDir: string): Hono {
  const app = new Hono();
  // `PRAGMA data_version` only moves for commits from other connections, so writes made through
  // this server are counted here; otherwise a second tab never hears about them.
  let ownWrites = 0;
  const version = () => dataVersion(rt) + ownWrites;

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
    if (!sameToken(c.req.query("token"), token)) {
      return wantsPage(c) ? stalePage(c) : c.text("Sign-in token refused.", 401);
    }
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
    if (wantsPage(c)) return stalePage(c);
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
  app.get("/api/snapshot", async (c) => c.json(await snapshot(rt, version)));

  app.use("/api/*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.res.ok) ownWrites++;
  });

  app.get("/api/search", async (c) => {
    const parsed = SearchQuery.safeParse(c.req.query("q") ?? "");
    if (!parsed.success) throw new SatiError("VALIDATION", "The search is over 500 characters.");
    const q = parsed.data;
    const hits = await rt.ctx.store.read((r) => r.search(rt.ctx.projectId, q, { limit: 20 }));
    return c.json({ hits });
  });

  // The Changes page: the same generators as `sati changes` and `sati feature list --format md`.
  app.get("/api/changes", async (c) => {
    const q = (name: string) => c.req.query(name) || undefined;
    const changes = await listChanges(rt.ctx, {
      since: q("since"),
      milestoneId: q("milestoneId"),
      actorId: q("actorId"),
    });
    return c.json({
      changes,
      changelog: formatChanges(changes, "changelog"),
      digest: formatChanges(changes, "digest"),
    });
  });
  app.get("/api/feature-list", async (c) => c.json({ markdown: await featureList(rt.ctx) }));
  // The Memory page: the same recall agents get, and card edits through the same service.
  app.get("/api/recall", async (c) =>
    c.json(await recall(rt.ctx, { question: c.req.query("q") ?? "" })),
  );
  app.post("/api/cards", async (c) => c.json(await putContext(rt.ctx, await body(c))));
  // The same hash and the same service as `card approve`. `RepoPath` refuses `..` and absolute
  // paths, so only a file inside the project is read; its bytes are hashed and dropped.
  app.post("/api/cards/approve", async (c) => {
    const { path, clear } = parseInput(ApproveBody, await body(c));
    if (clear) return c.json(await approveCard(rt.ctx, { path, hash: null }));
    const hash = rt.root === undefined ? undefined : fileSha256(resolve(rt.root, path));
    if (hash === undefined) {
      throw new SatiError("NOT_FOUND", `There is no file at ${path}.`, {
        hint: "Only a file in the project folder can be approved.",
      });
    }
    return c.json(await approveCard(rt.ctx, { path, hash }));
  });
  // The New plan menu: the same templates and the same apply as `sati template`.
  const templateFiles = () => rt.templates?.() ?? [];
  app.get("/api/templates", (c) => c.json(availableTemplates(templateFiles()).map(summarize)));
  app.post("/api/templates/apply", async (c) =>
    c.json(await applyTemplate(rt.ctx, templateFiles(), await body(c))),
  );

  app.post("/api/tasks", async (c) => c.json(await createTask(rt.ctx, await body(c))));
  app.patch("/api/tasks/:id", async (c) => {
    const id = c.req.param("id");
    const patch = await body(c);
    // Like the CLI, a write by the person who holds the claim carries their fencing token.
    const held = await rt.ctx.store.read((r) => r.get("task", id));
    const own = held?.claim?.actorId === rt.ctx.actorId ? held.claim.token : undefined;
    const withToken =
      own !== undefined && patch !== null && typeof patch === "object" && !("token" in patch)
        ? { ...patch, token: own }
        : patch;
    return c.json(await updateTask(rt.ctx, id, withToken));
  });
  app.post("/api/tasks/:id/release", async (c) =>
    c.json(await releaseTask(rt.ctx, c.req.param("id"), await body(c))),
  );
  app.post("/api/tasks/:id/take-over", async (c) =>
    c.json(await takeOverTask(rt.ctx, c.req.param("id"), await body(c))),
  );
  app.post("/api/claims/release-expired", async (c) => c.json(await releaseExpiredClaims(rt.ctx)));
  // Only a person uses the board, and markWaiting lets a person clear another's wait.
  app.post("/api/tasks/:id/answered", async (c) => {
    const [task] = await markWaiting(rt.ctx, { taskId: c.req.param("id"), waiting: null });
    return c.json(task);
  });

  app.post("/api/notes", async (c) => c.json(await createNote(rt.ctx, await body(c))));
  // A comment is a note; it is deleted and restored through the notes routes.
  app.post("/api/comments", async (c) => c.json(await addComment(rt.ctx, await body(c))));
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

  // Only the kind: the review gate and lease stay CLI settings.
  app.patch("/api/settings", async (c) => {
    const patch = SettingsPatch.safeParse(await body(c));
    if (!patch.success) throw new SatiError("VALIDATION", "Send { kind: code | general }.");
    const { kind } = readSettings((await updateSettings(rt.ctx, patch.data)).settings);
    rt.onKind?.(kind);
    return c.json({ kind });
  });

  app.patch("/api/actors/:id", async (c) =>
    c.json(await updateProfile(rt.ctx, c.req.param("id"), await body(c))),
  );

  // Deletes are soft, so the board's Undo is a restore of the same record.
  for (const [plural, entity] of [
    ["tasks", "task"],
    ["notes", "note"],
    ["decisions", "decision"],
  ] as const) {
    app.delete(`/api/${plural}/:id`, async (c) =>
      c.json(await deleteRecord(rt.ctx, entity, c.req.param("id"))),
    );
    app.post(`/api/${plural}/:id/restore`, async (c) =>
      c.json(await restoreRecord(rt.ctx, entity, c.req.param("id"))),
    );
  }

  // An unknown API path is a 404, not the SPA page with a 200 that a client would try to parse.
  app.all("/api/*", (c) =>
    c.json({ error: { code: "NOT_FOUND", message: "No such API path.", hint: null } }, 404),
  );

  app.get("/events", (c) => {
    let last = version();
    let timer: ReturnType<typeof setInterval> | undefined;
    // EventSource sends back the last `id:` it saw when it reconnects. Nothing written since
    // means the browser's copy is current, so it is not told to refetch the whole board.
    const resume = ActivityCursor.safeParse(c.req.header("last-event-id"));
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (cursor: string | undefined) => {
          // A git read can finish after the browser left; the stream is closed by then.
          if (closed) return;
          const id = cursor ? `id: ${cursor}\n` : "";
          controller.enqueue(
            new TextEncoder().encode(`${id}data: ${JSON.stringify({ version: last })}\n\n`),
          );
        };
        let cursor: string | undefined;
        let missed = true;
        if (resume.success) {
          try {
            cursor = await tailCursor(rt, resume.data);
            missed = cursor !== resume.data;
            if (closed) return;
          } catch {
            // An unknown cursor (compacted, or another database): start over.
            cursor = undefined;
          }
        }
        if (closed) return;
        cursor ??= await tailCursor(rt);
        // The browser can leave while a read is pending; cancel() has run, so no timer may start.
        if (closed) return;
        if (missed) send(cursor);
        let busy = false;
        timer = setInterval(() => {
          const now = version();
          if (now === last || busy) return;
          busy = true;
          last = now;
          void tailCursor(rt, cursor)
            .then((next) => {
              cursor = next;
              send(cursor);
            })
            .catch(() => send(cursor))
            .finally(() => {
              busy = false;
            });
        }, 250);
      },
      cancel() {
        closed = true;
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
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        const why =
          err.code === "EADDRINUSE" ? "is already in use" : "cannot be used: permission denied";
        reject(
          new SatiError("USAGE", `Port ${port} ${why}.`, {
            hint: "Pick another with --port, or omit it for a free one.",
          }),
        );
        return;
      }
      reject(err);
    };
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
