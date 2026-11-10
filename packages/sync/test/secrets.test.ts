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
import { afterWrites, exportSnapshot, refusedError } from "../src/index.js";

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

/** Saves a secret the way an older sati or a hand-edited database would: services refuse it now. */
async function plantSecret(ctx: ServiceContext) {
  const clean = await createNote(ctx, { title: "Setup", body: "Use the staging key" });
  const note = { ...clean, body: `Use ${sk} for staging`, version: clean.version + 1 };
  await ctx.store.write((w) => w.update("note", note, clean.version));
  return note;
}

describe("exportSnapshot secret refusal", () => {
  // WP1 1.1: one bad record used to fail the whole export, and the debounced export re-queued it
  // with every later batch, so nothing reached .sati/ again. Now the bad record is skipped and
  // reported, and the good ones are still written.
  it("skips a record holding a secret, writes the others, and never echoes the secret", async () => {
    const { ctx, dir } = await clone();
    const out = join(dir, ".sati");
    const task = await createTask(ctx, { title: "Clean task" });
    const note = await plantSecret(ctx);

    const result = await exportSnapshot(ctx, out);
    expect(result.written).toEqual([`tasks/${task.id}.json`]);
    expect(result.refused).toEqual([
      { path: `notes/${note.id}.json`, field: "body", kind: "API key (sk-)" },
    ]);
    expect(existsSync(join(out, `notes/${note.id}.json`))).toBe(false);

    const err = refusedError(result.refused);
    expect(err).toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining(`notes/${note.id}.json, field body: API key (sk-)`),
    });
    expect(err.message + JSON.stringify(err) + JSON.stringify(result)).not.toContain(sk);
  });

  // The debounce queue puts a batch back only when the export throws. A refused record must not
  // throw, or it would ride along with, and fail, every later batch.
  it("does not put a refused record back in the debounce queue", async () => {
    const { ctx, dir } = await clone();
    const out = join(dir, ".sati");
    const batches: string[][] = [];
    const errors: unknown[] = [];
    const synced = afterWrites(
      ctx.store,
      60_000,
      async (written) => {
        // Activity rows and actor touches ride along; only the records under test matter here.
        batches.push(
          written.filter((r) => r.entity === "task" || r.entity === "note").map((r) => r.id),
        );
        await exportSnapshot(ctx, out, { only: written });
      },
      (err) => errors.push(err),
    );
    const note = await plantSecret({ ...ctx, store: synced.store });
    await synced.flush();
    const task = await createTask({ ...ctx, store: synced.store }, { title: "Later, clean" });
    await synced.flush();

    expect(errors).toEqual([]);
    expect(batches.at(-1)).toEqual([task.id]);
    expect(batches.flat().filter((id) => id === note.id)).toHaveLength(1);
    expect(existsSync(join(out, `tasks/${task.id}.json`))).toBe(true);
  });
});
