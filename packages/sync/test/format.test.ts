import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdFactory,
  createTask,
  ENTITY_SCHEMAS,
  fixedClock,
  initProject,
  type ServiceContext,
  SNAPSHOT_ENTITIES,
  updateTask,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeRecord,
  EMPTY_FIELDS,
  encodeRecord,
  exportSnapshot,
  importSnapshot,
  mergeRecord,
  stableJson,
} from "../src/index.js";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function clone(projectId?: string): Promise<ServiceContext> {
  const dir = mkdtempSync(join(tmpdir(), "sati-format-"));
  dirs.push(dir);
  const store = await SqliteStore.open(join(dir, "sati.db"));
  stores.push(store);
  const clock = fixedClock("2026-11-03T12:00:00.000Z");
  const base = createIdFactory();
  const ids: typeof base = (e) => (e === "project" && projectId ? projectId : base(e));
  const { project, actor } = await initProject(
    { store, clock, ids },
    { slug: "demo", name: "Demo" },
    { name: "agent@test", kind: "agent" },
  );
  return { store, clock, ids, projectId: project.id, actorId: actor.id, branch: "main" };
}

type Rec = Record<string, unknown> & { stamps: Record<string, string> };

// The values a compact file leaves out are frozen; a schema change must not make one invalid,
// or every file in git that left it out would fail to import.
describe("compact empty fields", () => {
  it("are values each entity's schema still accepts", () => {
    for (const entity of SNAPSHOT_ENTITIES) {
      const shape = (
        ENTITY_SCHEMAS[entity] as unknown as {
          shape: Record<string, { safeParse(v: unknown): { success: boolean } }>;
        }
      ).shape;
      for (const [key, value] of Object.entries(EMPTY_FIELDS[entity])) {
        expect(shape[key]?.safeParse(value).success, `${entity}.${key}`).toBe(true);
      }
    }
  });
});

describe("compact snapshot records", () => {
  it("leaves out empty fields and writes a shared stamp once, at under half the size", async () => {
    const a = await clone();
    const task = await createTask(a, { title: "Ship it" });
    const compact = encodeRecord(task) as Rec;
    expect(Object.keys(compact.stamps)).toEqual(["*"]);
    for (const key of ["body", "labels", "claim", "branch", "deletedAt", "dependsOn"]) {
      expect(compact).not.toHaveProperty(key);
    }
    expect(compact).toMatchObject({ id: task.id, title: "Ship it", status: "todo" });
    expect(stableJson(compact).length * 2).toBeLessThan(stableJson(task).length);
    expect(decodeRecord(compact)).toEqual(task);
  });

  // The likely mistakes: an empty string read back as null, a nullable optional field that
  // vanishes, a stamp for a field the record no longer has, or `*` stamping a field that had
  // no stamp. Any of them makes some record come back different.
  it("reads every record back exactly as it was", async () => {
    const a = await clone();
    const task = (await createTask(a, { title: "Base" })) as unknown as Rec;
    const shared = Object.values(task.stamps)[0] ?? "";
    const other = "2026-11-03T13:00:00.000Z#000001#actr_other";
    const keys = Object.keys(task.stamps);
    fc.assert(
      fc.property(
        fc.constantFrom(null, "", "feat/x"),
        fc.constantFrom<string[]>([], ["ui"]),
        fc.constantFrom("", "notes"),
        fc.constantFrom(undefined, null, "why"),
        fc.array(fc.constantFrom("shared", "other"), {
          minLength: keys.length,
          maxLength: keys.length,
        }),
        // One field without a stamp (a record written before stamps), or none.
        fc.option(fc.constantFrom(...keys)),
        fc.boolean(),
        (branch, labels, body, reviewNote, stampKinds, unstamped, orphan) => {
          const stamps: Record<string, string> = {};
          keys.forEach((key, i) => {
            if (key !== unstamped) stamps[key] = stampKinds[i] === "other" ? other : shared;
          });
          // A field cleared from the record keeps the stamp of the write that cleared it.
          if (orphan) stamps.acknowledged = shared;
          const record: Rec = { ...task, branch, labels, body, stamps };
          if (reviewNote !== undefined) record.reviewNote = reviewNote;
          const written = JSON.parse(stableJson(encodeRecord(record)));
          expect(decodeRecord(written)).toEqual(record);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("imports files in the full form written before this format", async () => {
    const a = await clone();
    const b = await clone(a.projectId);
    const task = await createTask(a, { title: "Old file" });
    const dir = dirs[0] ?? "";
    const snap = join(dir, "snap");
    await exportSnapshot(a, snap);
    const file = join(snap, "tasks", `${task.id}.json`);
    expect(readFileSync(file, "utf8")).toBe(stableJson(encodeRecord(task)));
    writeFileSync(file, stableJson(task));
    await importSnapshot(b, snap);
    expect(await b.store.read((r) => r.get("task", task.id))).toEqual(task);
  });

  // What the merge driver does: decode each side, merge, encode. Merged raw, the shared stamp
  // would hide theirs' title stamp, and `updatedAt` would pick the older title.
  it("merges compact sides by their per-field clocks", async () => {
    const a = await clone();
    const t = await createTask(a, { title: "Base", labels: ["x"] });
    a.clock.now = () => new Date("2026-11-03T12:05:00.000Z");
    const ours = await updateTask(a, t.id, { title: "Ours, written later" });
    // Theirs edited title earlier but bumped updatedAt later with an unrelated field.
    const theirs = {
      ...t,
      title: "Theirs, written earlier",
      labels: [],
      version: 3,
      updatedAt: "2026-11-03T12:10:00.000Z",
      stamps: { ...t.stamps, title: t.stamps?.title ?? "", labels: ours.stamps?.title ?? "" },
    };
    const side = (r: unknown) =>
      decodeRecord(JSON.parse(stableJson(encodeRecord(r)))) as Parameters<typeof mergeRecord>[1];
    const merged = mergeRecord(side(t), side(ours), side(theirs)).record;
    expect(merged.title).toBe("Ours, written later");
    expect(merged.labels).toEqual([]);
  });
});
