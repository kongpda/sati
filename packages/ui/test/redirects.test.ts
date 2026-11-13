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

describe("the Agents page", () => {
  it("is now the Team page", () => {
    expect(resolveUrl("/agents", "").path).toBe("/team");
  });
});

describe("the Roadmap and Features pages", () => {
  it("sends /roadmap to the Milestones tab of Plan", () => {
    const r = resolveUrl("/roadmap", "");
    expect(r.path).toBe("/plan");
    expect(r.params.get("tab")).toBeNull();
  });
  it("sends /features to the Features tab of Plan", () => {
    const r = resolveUrl("/features", "");
    expect(r.path).toBe("/plan");
    expect(r.params.get("tab")).toBe("features");
  });
});

describe("Notes, Decisions and Memory", () => {
  it("are now kinds on the Knowledge page", () => {
    expect(resolveUrl("/notes", "").path).toBe("/knowledge");
    expect(resolveUrl("/notes", "").params.get("kind")).toBeNull();
    const decisions = resolveUrl("/decisions", "");
    expect([decisions.path, decisions.params.get("kind")]).toEqual(["/knowledge", "decisions"]);
    const memory = resolveUrl("/memory", "?task=tsk_1");
    expect([memory.path, memory.params.get("kind"), memory.params.get("task")]).toEqual([
      "/knowledge",
      "cards",
      "tsk_1",
    ]);
  });
});
