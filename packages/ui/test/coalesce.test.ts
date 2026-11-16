import { afterEach, describe, expect, it, vi } from "vitest";
import { coalesce } from "../src/coalesce.js";

afterEach(() => vi.useRealTimers());

// Review 2026-11-16: every live event refetched the whole snapshot, and the server rebuilds it
// from scratch each time. Agents writing several times a second made the board and the server
// do several full rebuilds a second. A burst must cost two fetches, and a lone event none extra.
describe("coalesce", () => {
  it("runs the first call at once and folds a burst into one more run", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const call = coalesce(run, 500);
    call();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(20);
      call();
    }
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs at once again after a quiet spell, and runs nothing after cancel", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const call = coalesce(run, 500);
    call();
    vi.advanceTimersByTime(2000);
    call();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledTimes(2);
    call();
    call.cancel();
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
