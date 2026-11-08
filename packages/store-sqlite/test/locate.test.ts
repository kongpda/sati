import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearLocateCache, locateDb, SqliteStore } from "../src/index.js";
import { pragma } from "./fixtures.js";

// native: on Windows this expands 8.3 short names (RUNNER~1), as git does.
const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "sati-locate-")));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

const writeConfig = (dir: string, mode: string) => {
  mkdirSync(join(dir, ".sati"), { recursive: true });
  writeFileSync(
    join(dir, ".sati", "sati.config.json"),
    JSON.stringify({ version: 1, projectId: "prj_01JC0000000000000000000000", mode }),
  );
};

beforeEach(() => clearLocateCache());

describe("locateDb", () => {
  // The core promise of git mode: every worktree of a repo shares one live DB.
  it("gives the main checkout and a linked worktree the same DB inside .git", () => {
    const repo = tmp();
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    const wt = join(tmp(), "feature-a");
    git(repo, "worktree", "add", "-q", wt);
    mkdirSync(join(repo, "src", "deep"), { recursive: true });

    const main = locateDb(join(repo, "src", "deep"));
    const linked = locateDb(wt);
    expect(main.path).toBe(join(repo, ".git", "sati", "sati.db"));
    expect(linked.path).toBe(main.path);
    expect(main).toMatchObject({ mode: "git", root: repo });
    expect(linked.root).toBe(wt);
  });

  it("uses ~/.sati/projects/<id>.db for a standalone project outside git", () => {
    const dir = tmp();
    const home = tmp();
    writeConfig(dir, "standalone");
    mkdirSync(join(dir, "notes"));
    const loc = locateDb(join(dir, "notes"), { home });
    expect(loc).toEqual({
      path: join(home, ".sati", "projects", "prj_01JC0000000000000000000000.db"),
      mode: "standalone",
      root: dir,
    });
  });

  it("reports NOT_INITIALIZED outside git with no standalone config", () => {
    expect(() => locateDb(tmp(), { home: tmp() })).toThrow(
      expect.objectContaining({ code: "NOT_INITIALIZED" }),
    );
  });

  it("ignores a non-standalone config outside git", () => {
    const dir = tmp();
    writeConfig(dir, "git");
    expect(() => locateDb(dir, { home: tmp() })).toThrow(
      expect.objectContaining({ code: "NOT_INITIALIZED" }),
    );
  });

  it("rejects a malformed config with VALIDATION", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".sati"));
    writeFileSync(join(dir, ".sati", "sati.config.json"), "{nope");
    expect(() => locateDb(dir, { home: tmp() })).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
  });

  it("returns a path SqliteStore can open, creating parent folders", async () => {
    const repo = tmp();
    git(repo, "init", "-q");
    const store = await SqliteStore.open(locateDb(repo).path);
    expect(pragma(store.db, "journal_mode")).toBe("wal");
    await store.close();
  });
});
