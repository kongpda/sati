import { describe, expect, it } from "vitest";
import { findDependencyCycle, isClaimActive, isReady } from "../src/domain/rules.js";

const graph = (g: Record<string, string[]>) => (id: string) => g[id];

describe("findDependencyCycle", () => {
  it("accepts an acyclic graph", () => {
    expect(findDependencyCycle("a", ["b"], graph({ b: ["c"], c: [] }))).toBeUndefined();
  });

  it("rejects a self dependency", () => {
    expect(findDependencyCycle("a", ["a"], graph({}))).toEqual(["a", "a"]);
  });

  it("reports the full path of an indirect cycle", () => {
    expect(findDependencyCycle("a", ["b"], graph({ b: ["c"], c: ["a"] }))).toEqual([
      "a",
      "b",
      "c",
      "a",
    ]);
  });

  it("ignores cycles that do not pass through the edited task", () => {
    expect(findDependencyCycle("a", ["b"], graph({ b: ["c"], c: ["b"] }))).toBeUndefined();
  });

  it("handles diamonds without false positives", () => {
    expect(
      findDependencyCycle("a", ["b", "c"], graph({ b: ["d"], c: ["d"], d: [] })),
    ).toBeUndefined();
  });
});

describe("isReady", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");
  const base = { status: "todo" as const, claim: null, dependsOn: [], deletedAt: null };
  const claim = (leaseUntil: string) => ({
    actorId: "actr_01JC0000000000000000000000",
    leaseUntil,
    heartbeatAt: "2026-11-03T11:00:00.000Z",
  });

  it("is ready when todo, unclaimed and no deps", () => {
    expect(isReady(base, () => undefined, now)).toBe(true);
  });

  it("is not ready until every dependency is done", () => {
    const t = { ...base, dependsOn: ["x", "y"] };
    expect(isReady(t, (id) => (id === "x" ? "done" : "in_progress"), now)).toBe(false);
    expect(isReady(t, () => "done", now)).toBe(true);
    // Cancelled work will never be done, so it stops blocking; a missing dependency still blocks.
    expect(isReady(t, (id) => (id === "x" ? "done" : "cancelled"), now)).toBe(true);
    expect(isReady(t, (id) => (id === "x" ? "done" : undefined), now)).toBe(false);
  });

  // An agent that died must not hold a task forever: an expired lease frees it.
  it("treats an expired claim as unclaimed and a live one as taken", () => {
    expect(
      isReady({ ...base, claim: claim("2026-11-03T11:59:59.000Z") }, () => undefined, now),
    ).toBe(true);
    expect(
      isReady({ ...base, claim: claim("2026-11-03T12:30:00.000Z") }, () => undefined, now),
    ).toBe(false);
    expect(isClaimActive({ claim: null }, now)).toBe(false);
  });

  it("is never ready when deleted or not todo", () => {
    expect(isReady({ ...base, deletedAt: "2026-11-03T00:00:00.000Z" }, () => undefined, now)).toBe(
      false,
    );
    expect(isReady({ ...base, status: "backlog" }, () => undefined, now)).toBe(false);
  });
});
