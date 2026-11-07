import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdFactory,
  createNote,
  createTask,
  fixedClock,
  initProject,
  type ServiceContext,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { exportSnapshot } from "../src/index.js";

// Built from pieces so this file itself never trips a secret scanner.
const sk = `s${"k-"}ant-${"x9".repeat(15)}`;

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function clone(): Promise<{ ctx: ServiceContext; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "sati-secrets-"));
  dirs.push(dir);
  const store = await SqliteStore.open(join(dir, "sati.db"));
  stores.push(store);
  const deps = { store, clock: fixedClock("2026-11-03T12:00:00.000Z"), ids: createIdFactory() };
  const { project, actor } = await initProject(
    deps,
    { slug: "demo", name: "Demo" },
    { name: "agent@test", kind: "agent" },
  );
  return { ctx: { ...deps, projectId: project.id, actorId: actor.id, branch: "main" }, dir };
}

describe("exportSnapshot secret refusal", () => {
  // PLAN Security: refuse with a clear message before writing to .sati/, so no commit carries it.
  it("refuses the whole export, writes no file, and does not print the secret", async () => {
    const { ctx, dir } = await clone();
    const out = join(dir, ".sati");
    await createTask(ctx, { title: "Clean task" });
    // Saving through a service refuses the secret, so write the record the way an older version
    // or a hand-edited database would: the export is the last check before git.
    const clean = await createNote(ctx, { title: "Setup", body: "Use the staging key" });
    const note = { ...clean, body: `Use ${sk} for staging`, version: clean.version + 1 };
    await ctx.store.write((w) => w.update("note", note, clean.version));

    const err = await exportSnapshot(ctx, out).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining(`note ${note.id}, field body: API key (sk-)`),
    });
    expect(String((err as Error).message) + JSON.stringify(err)).not.toContain(sk);
    expect(existsSync(out)).toBe(false);
  });
});
