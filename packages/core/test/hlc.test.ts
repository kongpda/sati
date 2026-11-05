import { describe, expect, it } from "vitest";
import { compareHlc, formatHlc, maxHlc, parseHlc, tickHlc } from "../src/index.js";
import { createTask, updateTask } from "../src/services/task.js";
import { setup } from "./support/setup.js";

describe("tickHlc", () => {
  const wall = new Date("2026-11-03T12:00:00.000Z");
  const node = "actr_1";

  it("starts at the wall clock", () => {
    expect(tickHlc(wall, undefined, node)).toBe("2026-11-03T12:00:00.000Z#000000#actr_1");
  });

  // PLAN: a writer whose wall clock is behind still orders after every stamp it has seen.
  it("moves past a stamp it has seen when the wall clock is earlier", () => {
    const seen = "2026-11-03T14:00:00.000Z#000004#other";
    const next = tickHlc(new Date("2026-11-03T12:00:00.000Z"), seen, node);
    expect(compareHlc(next, seen)).toBeGreaterThan(0);
    expect(next.startsWith("2026-11-03T14:00:00.000Z#000005#")).toBe(true);
  });

  it("steps one millisecond when the counter is full, and ignores a stamp that is not ours", () => {
    const full = formatHlc(wall.getTime(), 999_999, "n");
    expect(tickHlc(wall, full, node)).toBe("2026-11-03T12:00:00.001Z#000000#actr_1");
    expect(parseHlc("nope")).toBeUndefined();
    expect(parseHlc("2026-99-99T00:00:00.000Z#000000#n")).toBeUndefined();
    expect(compareHlc("nope", "also-nope")).toBe(0);
    expect(compareHlc(formatHlc(wall.getTime(), 0, "b"), formatHlc(wall.getTime(), 0, "a"))).toBe(
      1,
    );
    expect(maxHlc([undefined, "nope", formatHlc(wall.getTime(), 1, "a")])).toBe(
      "2026-11-03T12:00:00.000Z#000001#a",
    );
  });
});

describe("write stamps", () => {
  it("stamps created fields, and a later write stays after them even if the clock jumps back", async () => {
    const { ctx, clock } = await setup();
    const created = await createTask(ctx, { title: "First" });
    const first = created.stamps?.title;
    expect(first).toMatch(/^2026-11-03T12:00:00\.000Z#000000#actr_/u);
    clock.set("2020-01-01T00:00:00.000Z");
    const updated = await updateTask(ctx, created.id, { title: "Second" });
    expect(updated.stamps?.title).toBeDefined();
    expect(compareHlc(updated.stamps?.title ?? "", first ?? "")).toBeGreaterThan(0);
    expect(updated.stamps?.body).toBe(first);
  });
});
