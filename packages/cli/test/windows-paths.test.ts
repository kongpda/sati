import { describe, expect, it, vi } from "vitest";

// Run the path code as it runs on Windows: Node's win32 path functions, while git prints
// `C:/repo/.git` with forward slashes. The review could not run Windows; this is the closest test.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.win32, default: actual.win32 };
});

const { absFrom } = await import("../src/hooks.js");
const { samePath } = await import("../src/git.js");

describe("Windows paths", () => {
  // `inTree` compares hook paths built with `resolve` (backslashes) against the git dir; a git
  // dir left as `C:/repo/.git` never matches, so sati would plan hooks in the wrong place.
  it("turns a git-printed absolute path into Node's form", () => {
    expect(absFrom("C:\\repo", "C:/repo/.git")).toBe("C:\\repo\\.git");
    expect(absFrom("C:\\repo", ".git")).toBe("C:\\repo\\.git");
  });

  // `git worktree list` prints `C:/repo/wt`; the task records `C:\repo\wt`. Without this, the
  // overlap warnings between worktrees never fire on Windows.
  it("matches a worktree path git printed with the one sati recorded", () => {
    expect(samePath("C:/repo/wt", "C:\\repo\\wt")).toBe(true);
    expect(samePath("C:/repo/wt", "C:\\repo\\wt\\")).toBe(true);
    expect(samePath("C:/repo/wt", "C:\\repo\\other")).toBe(false);
  });
});
