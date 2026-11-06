import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdFactory,
  createTask,
  fixedClock,
  importRecords,
  initProject,
  SatiError,
  type ServiceContext,
  snapshotRecords,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readSnapshot } from "../src/index.js";

// PLAN Security: fuzz the JSON importer. Snapshot files come from git, so a teammate, a bad
// merge or a hostile branch can put anything in them. The importer must refuse bad input with a
// VALIDATION error, never crash with another error, never write part of a refused import, and
// never let a `__proto__` key reach the object prototype.

const root = mkdtempSync(join(tmpdir(), "sati-fuzz-"));
let store: SqliteStore;
let ctx: ServiceContext;
let valid: Record<string, unknown>;

beforeAll(async () => {
  store = await SqliteStore.open(join(root, "sati.db"));
  const clock = fixedClock("2026-11-03T12:00:00.000Z");
  const ids = createIdFactory();
  const { project, actor } = await initProject(
    { store, clock, ids },
    { slug: "fuzz", name: "Fuzz" },
    { name: "agent@test", kind: "agent" },
  );
  ctx = { store, clock, ids, projectId: project.id, actorId: actor.id, branch: "main" };
  const task = await createTask(ctx, { title: "Seed", body: "Body", labels: ["a"] });
  valid = { ...task } as Record<string, unknown>;
});

afterAll(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

const json = fc.jsonValue({ maxDepth: 3 });
/** Keys a hostile file would try: unknown fields and prototype pollution. */
const key = fc.oneof(
  fc.constantFrom("__proto__", "constructor", "prototype", "id", "projectId", "status", "body"),
  fc.string({ maxLength: 8 }),
);

/** A real task record with some fields replaced, removed or added. */
const mutated = fc
  .array(fc.tuple(key, fc.option(json, { nil: undefined })), { minLength: 1, maxLength: 4 })
  .map((changes) => {
    // JSON.parse is how records arrive, so build the mutation the same way: it can create an
    // own `__proto__` key, which a spread or assignment cannot.
    const record = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    for (const [k, v] of changes) {
      if (v === undefined) delete record[k];
      else record[k] = v;
    }
    const text = JSON.stringify(record).replace('"constructor":', '"__proto__":');
    return JSON.parse(text) as unknown;
  });

const isValidation = (err: unknown) => err instanceof SatiError && err.code === "VALIDATION";

describe("importRecords fuzz", () => {
  it("refuses any malformed record with VALIDATION and leaves the database unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("task", "note", "feature", "decision", "milestone"),
        fc.oneof(mutated, json),
        async (entity, record) => {
          const before = await snapshotRecords(ctx);
          try {
            await importRecords(ctx, [{ entity, source: "fuzz.json", record }]);
          } catch (err) {
            if (!isValidation(err)) throw err;
            expect(await snapshotRecords(ctx)).toEqual(before);
          }
          expect(({} as Record<string, unknown>).polluted).toBeUndefined();
          expect(Object.getPrototypeOf({})).toBe(Object.prototype);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("refuses a malformed input envelope with VALIDATION", async () => {
    await fc.assert(
      fc.asyncProperty(json, async (input) => {
        try {
          await importRecords(ctx, input);
        } catch (err) {
          if (!isValidation(err)) throw err;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("all or nothing: one bad record in a batch blocks the good ones", async () => {
    const good = { ...valid, id: "tsk_fuzzgood", title: "Good" };
    const before = await snapshotRecords(ctx);
    await expect(
      importRecords(ctx, [
        { entity: "task", source: "good.json", record: good },
        { entity: "task", source: "bad.json", record: { ...valid, status: "nope" } },
      ]),
    ).rejects.toSatisfy(isValidation);
    expect(await snapshotRecords(ctx)).toEqual(before);
  });
});

describe("readSnapshot fuzz", () => {
  it("returns records or throws VALIDATION for any file content, never another error", () => {
    let n = 0;
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 200 }),
          json.map((v) => JSON.stringify(v)),
          mutated.map((v) => JSON.stringify(v)),
        ),
        fc.constantFrom("tsk_x.json", "tsk_y.json", "x.txt"),
        (content, name) => {
          const dir = join(root, `snap-${n++}`);
          mkdirSync(join(dir, "tasks"), { recursive: true });
          writeFileSync(join(dir, "tasks", name), content);
          try {
            const out = readSnapshot(dir);
            for (const item of out) expect(item.source).toBe(`tasks/${name}`);
          } catch (err) {
            if (!isValidation(err)) throw err;
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
