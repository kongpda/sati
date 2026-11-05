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

    const foreign = await app.request("http://evil.test/api/snapshot");
    expect(foreign.status).toBe(403);

    const session = await app.request(`http://127.0.0.1/session?token=${token}`);
    expect(session.status).toBe(302);
    const cookie = cookieOf(session);
    expect(cookie.startsWith("sati_session=")).toBe(true);
    expect(session.headers.get("set-cookie")).toContain("HttpOnly");

    const wrongOrigin = await app.request("http://127.0.0.1/api/snapshot", {
      headers: { cookie, origin: "http://evil.test" },
    });
    expect(wrongOrigin.status).toBe(403);

    const snap = await app.request("http://127.0.0.1/api/snapshot", { headers: { cookie } });
    expect(snap.status).toBe(200);
    expect(snap.headers.get("content-security-policy")).toContain("default-src 'self'");
    const body = (await snap.json()) as { tasks: { title: string }[] };
    expect(body.tasks.map((t) => t.title)).toEqual(["Paint the board"]);
  });
});
