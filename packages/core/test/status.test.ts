import { describe, expect, it } from "vitest";
import {
  FEATURE_STATUSES,
  FEATURE_TRANSITIONS,
  featureRemovalNeedsDecision,
  MILESTONE_TRANSITIONS,
  TASK_STATUSES,
  TASK_TRANSITIONS,
} from "../src/domain/status.js";

// The production code asserts transitions in assertTransition; this keeps the table tests readable.
const canTransition = <S extends string>(
  machine: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean => from === to || machine[from].includes(to);

describe("task status machine", () => {
  it("follows the main flow backlog -> todo -> in_progress -> review -> done", () => {
    const flow = ["backlog", "todo", "in_progress", "review", "done"] as const;
    for (const [i, to] of flow.entries()) {
      const from = flow[i - 1];
      if (from) expect(canTransition(TASK_TRANSITIONS, from, to)).toBe(true);
    }
  });

  // Skipping todo would let a task start work before it is planned and ready.
  it("does not jump from backlog straight to in_progress or done", () => {
    expect(canTransition(TASK_TRANSITIONS, "backlog", "in_progress")).toBe(false);
    expect(canTransition(TASK_TRANSITIONS, "backlog", "done")).toBe(false);
  });

  it("allows blocking and cancelling from any active state", () => {
    for (const s of ["backlog", "todo", "in_progress", "review"] as const) {
      expect(canTransition(TASK_TRANSITIONS, s, "blocked")).toBe(true);
      expect(canTransition(TASK_TRANSITIONS, s, "cancelled")).toBe(true);
    }
  });

  it("can reopen a done task only back to todo", () => {
    expect(TASK_TRANSITIONS.done).toEqual(["todo"]);
  });

  it("covers every status and only targets known statuses", () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    for (const targets of Object.values(TASK_TRANSITIONS)) {
      for (const t of targets) expect(TASK_STATUSES).toContain(t);
    }
  });

  it("treats a no-op transition as allowed", () => {
    expect(canTransition(TASK_TRANSITIONS, "done", "done")).toBe(true);
  });
});

describe("feature status machine", () => {
  it("removed is terminal", () => {
    expect(FEATURE_TRANSITIONS.removed).toEqual([]);
  });

  it("cannot un-ship a feature back to building", () => {
    expect(canTransition(FEATURE_TRANSITIONS, "shipped", "building")).toBe(false);
  });

  // This is the core guard promise: shipped work cannot vanish without a recorded why.
  it("requires a decision to remove a shipped or deprecated feature", () => {
    expect(featureRemovalNeedsDecision("shipped", "removed")).toBe(true);
    expect(featureRemovalNeedsDecision("deprecated", "removed")).toBe(true);
    expect(featureRemovalNeedsDecision("planned", "removed")).toBe(false);
    expect(featureRemovalNeedsDecision("building", "removed")).toBe(false);
    expect(featureRemovalNeedsDecision("shipped", "deprecated")).toBe(false);
  });

  it("covers every status", () => {
    expect(Object.keys(FEATURE_TRANSITIONS).sort()).toEqual([...FEATURE_STATUSES].sort());
  });
});

describe("milestone status machine", () => {
  it("goes planned -> active -> done and not planned -> done", () => {
    expect(canTransition(MILESTONE_TRANSITIONS, "planned", "active")).toBe(true);
    expect(canTransition(MILESTONE_TRANSITIONS, "active", "done")).toBe(true);
    expect(canTransition(MILESTONE_TRANSITIONS, "planned", "done")).toBe(false);
  });
});
