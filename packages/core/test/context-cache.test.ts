import { describe, expect, it } from "vitest";
import {
  approvalStates,
  approveCard,
  buildBrief,
  checkChanges,
  ensureActor,
  getContext,
  moduleHash,
  putContext,
  type RepoFile,
  type ServiceContext,
  shortHandle,
} from "../src/index.js";
import { countingReads } from "./support/count-reads.js";
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

/** The same project as seen by a person: only a person signs a file off. */
const asPerson = async (ctx: ServiceContext): Promise<ServiceContext> => ({
  ...ctx,
  actorId: (await ensureActor(ctx, { name: "dara@office", kind: "human" })).id,
});

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

  // Review 3.2: a save from an old form must not wipe what an agent wrote since. The card is an
  // upsert by path, so only a version check tells the two apart.
  it("refuses a stale card edit instead of overwriting an agent's newer card", async () => {
    const { ctx } = await withRepo([{ path: "docs/a.md", blob: "a1" }]);
    const first = await putContext(ctx, { path: "docs/a.md", summary: "First read." });
    await putContext(ctx, { path: "docs/a.md", summary: "An agent's newer read." });
    await expect(
      putContext(ctx, {
        path: "docs/a.md",
        summary: "From a stale form.",
        expectedVersion: first.version,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const [now] = await getContext(ctx, { path: "docs/a.md" });
    expect(now?.summary).toBe("An agent's newer read.");
    // With no version, it still upserts, as an agent's save always did.
    await putContext(ctx, { path: "docs/a.md", summary: "Upsert." });
    expect((await getContext(ctx, { path: "docs/a.md" }))[0]?.summary).toBe("Upsert.");
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

  // A card saved before its folder had a file list has no hash: "not checked", not "changed".
  it("keeps stale null for a card saved without a file list once one appears", async () => {
    const { ctx } = await setup();
    await putContext(ctx, { path: "venue", summary: "Quotes" });
    const later: ServiceContext = { ...ctx, repo: fakeRepo([{ path: "venue/a.pdf", blob: "1" }]) };
    expect((await getContext(later))[0]?.stale).toBeNull();
    expect((await buildBrief(later)).markdown).not.toContain("Stale context");
  });

  // Deep review 2026-11-11: sourceSeen was stored and never compared, so a card for a file sati
  // cannot list (no git, a shared drive) could never be told stale.
  it("compares the version the caller sees now with the one the card was saved with", async () => {
    const { ctx } = await setup();
    await putContext(ctx, { path: "budget.xlsx", summary: "Q3", sourceSeen: "2026-11-01T09:00Z" });
    const stale = async (seen?: string) =>
      (await getContext(ctx, { path: "budget.xlsx", seen }))[0]?.stale;
    expect(await stale()).toBeNull();
    expect(await stale("2026-11-01T09:00Z")).toBe(false);
    expect(await stale("2026-11-09T16:30Z")).toBe(true);
    await expect(getContext(ctx, { seen: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("does not let the caller's version hide a change the file list shows", async () => {
    const files: RepoFile[] = [{ path: "budget.xlsx", blob: "1" }];
    const { ctx } = await withRepo(files);
    await putContext(ctx, { path: "budget.xlsx", summary: "Q3", sourceSeen: "v1" });
    files[0] = { path: "budget.xlsx", blob: "2" };
    const later: ServiceContext = { ...ctx, repo: fakeRepo(files) };
    expect((await getContext(later, { path: "budget.xlsx", seen: "v1" }))[0]?.stale).toBe(true);
  });

  // Office files are large: one card per sheet, slide or page keeps each card small. sati cannot
  // see inside the file, so every part goes stale when the file changes.
  it("lets a card name a part of a file, stale when the file changes", async () => {
    const files: RepoFile[] = [
      { path: "budget.xlsx", blob: "1" },
      { path: "notes.md", blob: "1" },
    ];
    const { ctx } = await withRepo(files);
    await putContext(ctx, { path: "budget.xlsx#Sheet2", summary: "Venue costs" });
    await putContext(ctx, { path: "budget.xlsx#Totals", summary: "Totals" });
    const paths = async (path: string, repo = files) =>
      (await getContext({ ...ctx, repo: fakeRepo(repo) }, { path })).map((c) => [c.path, c.stale]);
    expect(await paths("budget.xlsx")).toEqual([
      ["budget.xlsx#Sheet2", false],
      ["budget.xlsx#Totals", false],
    ]);
    expect(await paths("budget.xlsx#Sheet2")).toEqual([["budget.xlsx#Sheet2", false]]);
    const changed = [{ path: "budget.xlsx", blob: "2" }, files[1] as RepoFile];
    expect(await paths("budget.xlsx#Sheet2", changed)).toEqual([["budget.xlsx#Sheet2", true]]);
  });

  // Office work lives in SharePoint, Drive and other folders. Those keys were refused, so what
  // an agent learned from them could not be saved at all.
  it("keeps a card for a web link or an outside file, matched whole and private by default", async () => {
    const { ctx } = await withRepo([{ path: "src/a.ts", blob: "1" }]);
    const link = "https://acme.sharepoint.com/sites/q3/Budget.xlsx?web=1";
    await putContext(ctx, { path: link, summary: "Q3 budget", sourceSeen: "v12" });
    const outside = await putContext(ctx, {
      path: "/Users/dara/Desktop/brief.docx",
      summary: "Brief",
    });
    // Its path names a folder on this machine, so it stays here unless the caller shares it.
    expect(outside.private).toBe(true);
    const [card] = await getContext(ctx, { path: link });
    expect(card).toMatchObject({ path: link, stale: null });
    expect(card?.private).toBeUndefined();
    // sati cannot see a link change: only the caller's own look tells.
    expect((await getContext(ctx, { path: link, seen: "v13" }))[0]?.stale).toBe(true);
    expect((await getContext(ctx, { path: link, seen: "v12" }))[0]?.stale).toBe(false);
    // `?` is part of the link, not a wildcard, and a project glob does not reach outside.
    expect(await getContext(ctx, { path: link.replace("web=1", "web=2") })).toEqual([]);
    expect((await getContext(ctx, { path: "**" })).map((c) => c.path)).toEqual([]);
    // A part of a linked file is its own card, found with the file.
    await putContext(ctx, { path: `${link}#Sheet2`, summary: "Totals" });
    expect((await getContext(ctx, { path: link })).map((c) => c.path)).toEqual([
      link,
      `${link}#Sheet2`,
    ]);
    for (const path of [
      "https://dara:pw@acme.com/x",
      "https://acme.com/x?sig=abc",
      "ftp://acme.com/x",
      "/Users/dara/../x",
    ]) {
      await expect(putContext(ctx, { path, summary: "s" })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
  });

  // The guard runs on every commit. With thousands of cards, reading each one to find the few a
  // person signed off made every commit pay for the whole card table.
  it("the guard loads only approved cards", async () => {
    const { ctx: agent } = await withRepo([
      { path: "deck.pptx", blob: "1" },
      { path: "notes.md", blob: "2" },
    ]);
    const ctx = await asPerson(agent);
    await putContext(ctx, { path: "notes.md", summary: "Meeting notes" });
    await putContext(ctx, { path: "deck.pptx", summary: "Launch deck" });
    const deck = await approveCard(ctx, { path: "deck.pptx", hash: "a".repeat(64) });
    const counting = countingReads(ctx);
    const result = await checkChanges(counting.ctx, {
      changes: [{ path: "deck.pptx" }],
      approvedOnly: true,
    });
    expect(result.verdict).toBe("blocked");
    expect(counting.listed("context")).toEqual([deck.id]);
  });

  // PLAN Phase 9: a general project has no features, so nothing protected a signed-off file.
  // An agent could overwrite the approved deck and no check would say so.
  it("blocks a change to an approved file until the new version is approved", async () => {
    const { ctx: agent } = await withRepo([{ path: "deck.pptx", blob: "1" }]);
    const ctx = await asPerson(agent);
    const v1 = "a".repeat(64);
    const v2 = "b".repeat(64);
    await putContext(ctx, { path: "deck.pptx", summary: "Launch deck", facts: ["12 slides"] });
    const card = await approveCard(ctx, { path: "deck.pptx", hash: v1 });
    expect(card).toMatchObject({ facts: ["12 slides"], approved: { hash: v1, by: ctx.actorId } });
    const check = (change: object) =>
      checkChanges(ctx, { changes: [{ path: "deck.pptx", ...change }], approvedOnly: true });
    // An edit about to happen, a changed file and a removal are all blocked.
    for (const change of [{}, { contentHash: v2 }, { kind: "deleted", contentHash: v1 }]) {
      const result = await check(change);
      expect(result.verdict).toBe("blocked");
      expect(result.findings[0]).toMatchObject({ rule: "approved-changed", cardId: card.id });
    }
    // The same bytes are no change, and another file is not its business.
    expect((await check({ contentHash: v1 })).verdict).toBe("ok");
    expect(
      (await checkChanges(ctx, { changes: [{ path: "notes.md" }], approvedOnly: true })).verdict,
    ).toBe("ok");
    // A new card for the file keeps the approval; approving the new version lets it through.
    await putContext(ctx, { path: "deck.pptx", summary: "Launch deck v2" });
    expect((await check({ contentHash: v2 })).verdict).toBe("blocked");
    await approveCard(ctx, { path: "deck.pptx", hash: v2 });
    expect((await check({ contentHash: v2 })).verdict).toBe("ok");
    await approveCard(ctx, { path: "deck.pptx", hash: null });
    expect((await check({})).verdict).toBe("ok");
    // A file nobody read yet can be approved; a part or a wildcard cannot.
    expect((await approveCard(ctx, { path: "contract.pdf", hash: v1 })).summary).toBe(
      "Approved file.",
    );
    for (const path of ["deck.pptx#slide-2", "*.pptx"]) {
      await expect(approveCard(ctx, { path, hash: v1 })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
  });

  // The approval is a person's word. An agent that could approve its own new version, or clear
  // the approval, would walk through the guard that the approval exists to hold.
  it("lets only a person approve a file or take the approval away", async () => {
    const { ctx: agent } = await withRepo([{ path: "deck.pptx", blob: "1" }]);
    const person = await asPerson(agent);
    const v1 = "a".repeat(64);
    const refused = { code: "INVALID_TRANSITION", message: expect.stringContaining("person") };
    await expect(approveCard(agent, { path: "deck.pptx", hash: v1 })).rejects.toMatchObject(
      refused,
    );
    await approveCard(person, { path: "deck.pptx", hash: v1 });
    await expect(
      approveCard(agent, { path: "deck.pptx", hash: "b".repeat(64) }),
    ).rejects.toMatchObject(refused);
    await expect(approveCard(agent, { path: "deck.pptx", hash: null })).rejects.toMatchObject(
      refused,
    );
    // Nothing the agent tried changed the approval.
    const [kept] = await approvalStates(agent);
    expect(kept?.card.approved).toMatchObject({ hash: v1, by: person.actorId });
  });

  // The guard speaks at commit time. In a shared folder a file changes with no commit, and an
  // agent should hear before it builds on a version nobody approved.
  it("tells in the brief when an approved file changed or went missing", async () => {
    const { ctx: base } = await withRepo([]);
    const now = new Map<string, string | null | undefined>();
    const agent: ServiceContext = {
      ...base,
      repo: { ...fakeRepo([]), sha256: async (path) => now.get(path) ?? null },
    };
    const person = await asPerson(agent);
    const v1 = "a".repeat(64);
    for (const path of ["deck.pptx", "contract.pdf", "film.mov"]) {
      now.set(path, v1);
      await approveCard(person, { path, hash: v1 });
    }
    const states = async () =>
      Object.fromEntries((await approvalStates(agent)).map((s) => [s.card.path, s.state]));
    expect(await states()).toEqual({
      "deck.pptx": "kept",
      "contract.pdf": "kept",
      "film.mov": "kept",
    });
    expect((await buildBrief(agent)).markdown).not.toContain("Watch out");

    now.set("deck.pptx", "b".repeat(64));
    now.set("contract.pdf", null);
    // Too large to hash on every brief: not called changed, not called kept.
    now.set("film.mov", undefined);
    agent.repo = { ...fakeRepo([]), sha256: async (path) => now.get(path) };
    expect(await states()).toEqual({
      "deck.pptx": "changed",
      "contract.pdf": "missing",
      "film.mov": "unchecked",
    });
    const { markdown } = await buildBrief(agent);
    expect(markdown).toContain("deck.pptx changed since a person approved it");
    expect(markdown).toContain("contract.pdf was approved by a person and is no longer there");
    expect(markdown).not.toContain("film.mov");
    // With no way to read files (a store with no folder), nothing is claimed either way.
    expect(await approvalStates({ ...agent, repo: fakeRepo([]) })).toEqual([
      expect.objectContaining({ state: "unchecked" }),
      expect.objectContaining({ state: "unchecked" }),
      expect.objectContaining({ state: "unchecked" }),
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
