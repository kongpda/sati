import { describe, expect, it } from "vitest";
import { resolveUrl } from "../src/redirects.js";

describe("old addresses", () => {
  it("sends /activity to the Log tab of Changes, so a bookmark still works", () => {
    const r = resolveUrl("/activity", "");
    expect(r.path).toBe("/changes");
    expect(r.params.get("tab")).toBe("log");
    expect(r.moved).toBe(true);
  });
  it("keeps the open task when it sends a link on", () => {
    expect(resolveUrl("/activity", "?task=tsk_1").params.get("task")).toBe("tsk_1");
  });
  it("leaves current pages alone", () => {
    expect(resolveUrl("/changes", "?tab=log").moved).toBe(false);
  });
});
