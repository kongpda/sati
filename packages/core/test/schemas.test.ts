import { describe, expect, it } from "vitest";
import { LIMITS, Note, Task } from "../src/domain/schemas.js";

const now = "2026-11-03T12:00:00.000Z";
const actor = "actr_01JC0000000000000000000000";
const task = {
  id: "tsk_01JC0000000000000000000001",
  projectId: "prj_01JC0000000000000000000000",
  createdAt: now,
  updatedAt: now,
  createdBy: actor,
  version: 1,
  deletedAt: null,
  title: "Write the merge driver",
  body: "",
  status: "todo",
  priority: "medium",
  featureId: null,
  parentId: null,
  dependsOn: [],
  labels: [],
  branch: null,
  worktree: null,
  claim: null,
  completion: null,
};

describe("Task schema", () => {
  it("accepts a valid task", () => {
    expect(Task.safeParse(task).success).toBe(true);
  });

  // Imported JSON must not smuggle in fields we do not know about.
  it("rejects unknown fields", () => {
    expect(Task.safeParse({ ...task, evil: true }).success).toBe(false);
  });

  // A done task without a summary loses what was learned; the next agent redoes it.
  it("rejects done without a completion", () => {
    expect(Task.safeParse({ ...task, status: "done" }).success).toBe(false);
    const completion = {
      summary: "did it",
      filesTouched: ["a.ts"],
      completedAt: now,
      completedBy: actor,
    };
    expect(Task.safeParse({ ...task, status: "done", completion }).success).toBe(true);
    expect(
      Task.safeParse({ ...task, status: "done", completion: { ...completion, filesTouched: [] } })
        .success,
    ).toBe(false);
  });

  it("enforces size limits on bodies and arrays", () => {
    expect(Task.safeParse({ ...task, body: "x".repeat(LIMITS.body + 1) }).success).toBe(false);
    const labels = Array.from({ length: LIMITS.array + 1 }, (_, i) => `l${i}`);
    expect(Task.safeParse({ ...task, labels }).success).toBe(false);
  });

  it("rejects ids with the wrong prefix", () => {
    expect(Task.safeParse({ ...task, featureId: "tsk_01JC0000000000000000000002" }).success).toBe(
      false,
    );
  });

  it("rejects non-UTC timestamps", () => {
    expect(Task.safeParse({ ...task, createdAt: "2026-11-03T12:00:00+07:00" }).success).toBe(false);
  });
});

describe("Note schema", () => {
  it("trims and requires a title", () => {
    const note = {
      id: "note_01JC0000000000000000000001",
      projectId: task.projectId,
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      version: 1,
      deletedAt: null,
      title: "   ",
      body: "",
      tags: [],
      links: [],
      pinned: false,
    };
    expect(Note.safeParse(note).success).toBe(false);
    expect(Note.parse({ ...note, title: "  Khmer ខ្មែរ  " }).title).toBe("Khmer ខ្មែរ");
  });
});
