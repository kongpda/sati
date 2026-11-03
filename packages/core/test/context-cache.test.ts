import { describe, expect, it } from "vitest";
import {
  buildBrief,
  getContext,
  moduleHash,
  putContext,
  type RepoFile,
  type ServiceContext,
  shortHandle,
} from "../src/index.js";
import { setup } from "./support/setup.js";

/** A git index the test edits in place, standing in for `git ls-files -s`. */
function fakeRepo(files: RepoFile[], head: string | null = "c0ffee") {
  return { files: async () => [...files], head: async () => head };
}

async function withRepo(files: RepoFile[]) {
  const s = await setup();
  const ctx: ServiceContext = { ...s.ctx, repo: fakeRepo(files) };
  return { ...s, ctx };
}

describe("moduleHash", () => {
  // The hash must cover exactly the module's files: a change elsewhere must not mark it stale.
  it("covers a directory and everything beneath it, or what a glob matches", () => {
    const files = [
      { path: "src/auth/login.ts", blob: "a1" },
      { path: "src/auth/deep/token.ts", blob: "a2" },
      { path: "src/authz.ts", blob: "b1" },
      { path: "README.md", blob: "c1" },
    ];
    const before = moduleHash("src/auth", files);
    expect(moduleHash("src/auth", [...files.slice(0, 2)])).toBe(before);
    expect(moduleHash("src/auth", [{ ...files[1], blob: "zz" } as RepoFile, ...files])).not.toBe(
      before,
    );
    expect(moduleHash("src/*.ts", files)).toBe(moduleHash("src/*.ts", [files[2] as RepoFile]));
    // Order of git's output must not matter.
    expect(moduleHash("src/auth", [...files].reverse())).toBe(before);
  });
});

describe("context cache", () => {
  // PLAN: context_get recomputes hashes and marks stale entries, so agents re-read only the
  // modules that changed.
  it("marks an entry stale once a file under its path changes, and fresh again after put", async () => {
    const files = [
      { path: "src/auth/login.ts", blob: "a1" },
      { path: "src/billing/pay.ts", blob: "b1" },
    ];
    const { ctx } = await withRepo(files);
    const auth = await putContext(ctx, { path: "./src/auth/", summary: "Login flow" });
    await putContext(ctx, { path: "src/billing", summary: "Payments" });
    expect(auth).toMatchObject({ path: "src/auth", gitCommit: "c0ffee", keyFiles: [] });

    files[0] = { path: "src/auth/login.ts", blob: "a2" };
    expect((await getContext(ctx)).map((e) => [e.path, e.stale])).toEqual([
      ["src/auth", true],
      ["src/billing", false],
    ]);

    // Re-putting the same path updates the one entry instead of adding another.
    const again = await putContext(ctx, { path: "src/auth", summary: "Login flow v2" });
    expect(again).toMatchObject({ id: auth.id, version: 2 });
    expect(await getContext(ctx, { path: "src/auth/login.ts" })).toEqual([
      expect.objectContaining({ id: auth.id, summary: "Login flow v2", stale: false }),
    ]);
  });

  it("logs every put as activity", async () => {
    const { ctx, store } = await withRepo([]);
    const before = store.activity.length;
    const e = await putContext(ctx, { path: "src", summary: "All" });
    await putContext(ctx, { path: "src", summary: "All, revised" });
    expect(store.activity.slice(before).map((a) => [a.verb, a.entityId])).toEqual([
      ["create", e.id],
      ["update", e.id],
    ]);
  });

  // Without git, staleness is unknown; it must not be reported as fresh.
  it("reports stale as null when there is no git repo", async () => {
    const { ctx } = await setup();
    await putContext(ctx, { path: "src", summary: "All" });
    expect(await getContext(ctx)).toEqual([
      expect.objectContaining({ contentHash: "", gitCommit: null, stale: null }),
    ]);
  });

  it("rejects paths outside the repo and empty summaries", async () => {
    const { ctx } = await withRepo([]);
    await expect(putContext(ctx, { path: "../x", summary: "s" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(putContext(ctx, { path: "src", summary: "" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("lists stale entries in the brief, and not fresh ones", async () => {
    const files = [
      { path: "src/a.ts", blob: "1" },
      { path: "lib/b.ts", blob: "2" },
    ];
    const { ctx } = await withRepo(files);
    const stale = await putContext(ctx, { path: "src", summary: "Source tree" });
    await putContext(ctx, { path: "lib", summary: "Library" });
    files[0] = { path: "src/a.ts", blob: "9" };
    const { markdown } = await buildBrief(ctx);
    expect(markdown).toContain("## Stale context");
    expect(markdown).toContain("src: Source tree");
    expect(markdown).toContain(shortHandle(stale.id));
    expect(markdown).not.toContain("Library");
    expect((await buildBrief(ctx, { format: "short" })).markdown).not.toContain("Stale context");
  });
});
