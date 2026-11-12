import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { shortHandle } from "@sati/core";
import { locateDb, SqliteStore } from "@sati/store-sqlite";
import { stableJson } from "@sati/sync";
import { describe, expect, it } from "vitest";
import { bin, sati, satiJson, tempRepo } from "./helpers.js";

interface Rec {
  id: string;
  title: string;
}

async function projectId(dir: string): Promise<string> {
  const store = await SqliteStore.open(locateDb(dir).path);
  try {
    return (await store.read((r) => r.getProject()))?.id ?? "";
  } finally {
    await store.close();
  }
}

/** Runs git with `sati` on PATH, so the installed hooks can call it. */
function gitWithSati(dir: string, ...args: string[]): string {
  const shims = join(dir, ".git", "shims");
  if (!existsSync(shims)) {
    mkdirSync(shims);
    writeFileSync(join(shims, "sati"), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
    chmodSync(join(shims, "sati"), 0o755);
  }
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    env: { ...process.env, PATH: `${shims}${delimiter}${process.env.PATH}`, SATI_ACTOR: "tester" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("sati sync", () => {
  it("exports changed records to .sati/ and imports them into another clone", async () => {
    const a = await tempRepo({ init: true });
    const b = await tempRepo({ init: true });
    const task = satiJson<Rec>(a, "task", "create", "Shared").data;
    // PLAN: every CLI write exports in git mode, so the record is on disk before any commit.
    expect(existsSync(join(a, ".sati", "tasks", `${task.id}.json`))).toBe(true);
    expect(satiJson(a, "sync", "export").data).toEqual({
      written: [],
      unchanged: 1,
      newer: [],
      refused: [],
    });

    // Copy the snapshot by hand. Clones of one repo share the project id, so give b's id to the record.
    const file = readFileSync(join(a, ".sati", "tasks", `${task.id}.json`), "utf8");
    const bProject = await projectId(b);
    mkdirSync(join(b, ".sati", "tasks"), { recursive: true });
    writeFileSync(
      join(b, ".sati", "tasks", `${task.id}.json`),
      file.replace(/"projectId": "[^"]+"/, `"projectId": "${bProject}"`),
    );
    expect(sati(b, "sync", "import")).toMatchObject({
      code: 0,
      stdout: "Imported 1 newer, 0 unchanged.\n",
    });
    expect(satiJson<Rec>(b, "task", "show", task.id).data.title).toBe("Shared");
  });

  it("refuses stealth mode, which commits nothing", async () => {
    const dir = await tempRepo();
    sati(dir, "init", "--yes", "--mode", "stealth", "--tools", "");
    const r = sati(dir, "sync", "export");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("keeps none");
  });
});

// PLAN: pre-commit exports and stages .sati/; post-merge imports a teammate's records.
/** Puts a teammate's newer copy of a record in `.sati/` by hand, as a stash pop or `git apply` would. */
function placeNewer(dir: string, rel: string, title: string): string {
  const file = join(dir, ".sati", rel);
  const rec = JSON.parse(readFileSync(file, "utf8")) as { version: number };
  const text = stableJson({ ...rec, title, version: rec.version + 1 });
  writeFileSync(file, text);
  return text;
}

// Review 1.2: hooks do not fire on a stash pop, a cherry-pick or `git apply`, so a teammate's
// newer file can sit in .sati/ unimported. The full exports load it first instead of skipping it.
describe("import before the full exports", () => {
  it("pre-commit loads a newer file and commits it unchanged", async () => {
    const dir = await tempRepo();
    sati(dir, "init", "--yes", "--tools", "");
    const task = satiJson<Rec>(dir, "task", "create", "Mine").data;
    const text = placeNewer(dir, `tasks/${task.id}.json`, "Theirs");
    writeFileSync(join(dir, "README.md"), "hi\n");
    gitWithSati(dir, "add", "README.md");
    gitWithSati(dir, "commit", "-qm", "work");
    expect(satiJson<Rec>(dir, "task", "show", task.id).data.title).toBe("Theirs");
    expect(gitWithSati(dir, "show", `HEAD:.sati/tasks/${task.id}.json`)).toBe(text);
  });

  it("`sati mcp` loads a newer file when it starts", async () => {
    const dir = await tempRepo();
    sati(dir, "init", "--yes", "--tools", "");
    const task = satiJson<Rec>(dir, "task", "create", "Mine").data;
    placeNewer(dir, `tasks/${task.id}.json`, "Theirs");
    expect(sati(dir, "mcp").code).toBe(0);
    expect(satiJson<Rec>(dir, "task", "show", task.id).data.title).toBe("Theirs");
  });
});

describe("git hooks", () => {
  it("a commit carries the snapshot, and a pull brings it into the other clone's DB", async () => {
    const a = await tempRepo();
    const made = sati(a, "init", "--yes", "--tools", "");
    expect(made.code, made.stderr).toBe(0);
    writeFileSync(join(a, "README.md"), "hi\n");
    gitWithSati(a, "add", "README.md", ".sati/sati.config.json");
    gitWithSati(a, "commit", "-qm", "init");

    const b = `${a}-b`;
    execFileSync("git", ["clone", "-q", a, b]);
    sati(b, "init", "--yes", "--tools", "");

    const task = satiJson<Rec>(a, "task", "create", "From a").data;
    writeFileSync(join(a, "README.md"), "changed\n");
    gitWithSati(a, "add", "README.md");
    gitWithSati(a, "commit", "-qm", "work");
    const committed = gitWithSati(a, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toContain(`.sati/tasks/${task.id}.json`);

    gitWithSati(b, "pull", "-q", "--no-rebase", "origin", "main");
    expect(satiJson<Rec>(b, "task", "show", task.id).data.title).toBe("From a");
  });
});

// PLAN Security: a secret in a record must never reach a commit.
describe("secret scanner", () => {
  // Why: the warning called itself, so a write on such a record ended in "Maximum call stack
  // size exceeded" and "This is a bug", though the write itself was kept.
  it("warns and keeps the write when the export refuses the record", async () => {
    const dir = await tempRepo();
    sati(dir, "init", "--yes", "--tools", "");
    const secret = `gh${"p_"}${"a1".repeat(18)}`;
    const note = satiJson<Rec & { version: number }>(dir, "note", "create", "Setup").data;
    const store = await SqliteStore.open(locateDb(dir).path);
    try {
      await store.write(async (w) => {
        const before = await w.get("note", note.id);
        if (before)
          await w.update(
            "note",
            { ...before, body: `token ${secret}`, version: note.version + 1 },
            note.version,
          );
      });
    } finally {
      await store.close();
    }
    const pinned = sati(dir, "note", "update", note.id, "--pinned");
    expect(pinned.stderr).not.toContain("call stack");
    expect(pinned.stderr).toContain("the .sati/ snapshot was not updated");
    expect(pinned.stderr).toContain("field body: GitHub token");
    expect(pinned.stderr).not.toContain(secret);
    expect(pinned.code).toBe(0);
    expect(satiJson<{ pinned: boolean }>(dir, "note", "show", note.id).data.pinned).toBe(true);
  });

  it("blocks the commit and names the record, without printing the secret", async () => {
    const dir = await tempRepo();
    sati(dir, "init", "--yes", "--tools", "");
    const secret = `gh${"p_"}${"a1".repeat(18)}`;
    // A write is refused first: nothing saved, the field named, the secret never echoed.
    const refused = sati(dir, "note", "create", "Setup", "--body", `token ${secret}`);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("in body");
    expect(refused.stdout + refused.stderr).not.toContain(secret);
    // A record that reached the database another way (an older version, a hand edit) is still
    // stopped by pre-commit before it reaches git.
    const note = satiJson<Rec & { version: number }>(dir, "note", "create", "Setup").data;
    const store = await SqliteStore.open(locateDb(dir).path);
    try {
      await store.write(async (w) => {
        const before = await w.get("note", note.id);
        if (before)
          await w.update(
            "note",
            { ...before, body: `token ${secret}`, version: note.version + 1 },
            note.version,
          );
      });
    } finally {
      await store.close();
    }
    writeFileSync(join(dir, "README.md"), "hi\n");
    gitWithSati(dir, "add", "README.md");

    let stderr = "";
    expect(() => {
      try {
        gitWithSati(dir, "commit", "-qm", "leak");
      } catch (err) {
        stderr = String((err as { stderr?: unknown }).stderr);
        throw err;
      }
    }).toThrow();
    expect(stderr).toContain(`notes/${note.id}.json, field body: GitHub token`);
    expect(stderr).not.toContain(secret);
    // Review 1.1: the export skips the bad record but writes the others, and still fails.
    const other = satiJson<Rec>(dir, "task", "create", "Fine").data;
    const exported = sati(dir, "sync", "export");
    expect(exported.code).toBe(5);
    expect(exported.stderr).toContain(`notes/${note.id}.json, field body: GitHub token`);
    expect(existsSync(join(dir, ".sati", "tasks", `${other.id}.json`))).toBe(true);
    expect(readFileSync(join(dir, ".sati", "notes", `${note.id}.json`), "utf8")).not.toContain(
      secret,
    );
    expect(() => gitWithSati(dir, "rev-parse", "-q", "--verify", "HEAD")).toThrow();
  });
});

/** Commits record-only changes the way a person would, with `commit -a`. */
function commitRecords(dir: string, message: string): void {
  gitWithSati(dir, "commit", "-qam", message);
}

// PLAN: git decides "nothing to commit" for `commit -a` before pre-commit runs, so a record-only
// commit works only because each CLI write has already exported .sati/.
describe("record-only commit", () => {
  it("`git commit -a` carries a changed record with no code change", async () => {
    const dir = await tempRepo();
    sati(dir, "init", "--yes", "--tools", "");
    const task = satiJson<Rec>(dir, "task", "create", "One").data;
    gitWithSati(dir, "add", "-A");
    gitWithSati(dir, "commit", "-qm", "base");
    sati(dir, "task", "update", task.id, "--title", "Renamed");
    commitRecords(dir, "rename");
    const shown = gitWithSati(dir, "show", `HEAD:.sati/tasks/${task.id}.json`);
    expect(shown).toContain('"title": "Renamed"');
  });
});

// PLAN: the merge driver merges .sati/ JSON per field; a body conflict never fails the merge.
describe("merge driver", () => {
  it("merges two branches' edits to one task and flags a body conflict for review", async () => {
    const dir = await tempRepo();
    sati(dir, "init", "--yes", "--tools", "");
    const task = satiJson<Rec>(dir, "task", "create", "Shared", "--body", "one\ntwo\nthree").data;
    gitWithSati(dir, "add", "-A");
    gitWithSati(dir, "commit", "-qm", "base");

    gitWithSati(dir, "checkout", "-qb", "side");
    sati(dir, "task", "update", task.id, "--title", "Renamed", "--body", "one\nSIDE\nthree");
    commitRecords(dir, "side");
    gitWithSati(dir, "checkout", "-q", "main");
    sati(dir, "task", "update", task.id, "--labels", "x", "--body", "one\nMAIN\nthree");
    commitRecords(dir, "main");

    // Plain git would stop with a JSON conflict; the driver merges and post-merge imports.
    gitWithSati(dir, "merge", "-q", "--no-edit", "side");
    const merged = satiJson<Rec & { labels: string[]; body: string; needsReview?: boolean }>(
      dir,
      "task",
      "show",
      task.id,
    ).data;
    expect(merged).toMatchObject({ title: "Renamed", labels: ["x"], needsReview: true });
    expect(merged.body).toContain("<<<<<<< ours\nMAIN\n=======\nSIDE\n>>>>>>> theirs");

    // The flag is useful only if a person can find the record and say it has been read.
    const handle = shortHandle(task.id);
    expect(sati(dir, "doctor").stdout).toContain(handle);
    const cleared = sati(dir, "doctor", "--reviewed", task.id);
    expect(cleared.stderr + cleared.stdout).toContain("Cleared needsReview");
    const after = satiJson<Rec & { needsReview?: boolean }>(dir, "task", "show", task.id).data;
    expect(after.needsReview).toBeUndefined();
    expect(sati(dir, "doctor").stdout).not.toContain(handle);
  }, 30_000);
});

// PLAN: context entries hash the module's files from `git ls-files -s` and go stale on change.
describe("sati context", () => {
  it("flags an entry stale after a file under its path is staged, and fresh after put", async () => {
    const dir = await tempRepo({ init: true });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "other.ts"), "x\n");
    gitWithSati(dir, "add", "-A");
    const put = satiJson<{ id: string }>(
      dir,
      "context",
      "put",
      "src",
      "--summary",
      "Source tree",
      "--key-files",
      "src/a.ts",
    );
    expect(put.code).toBe(0);
    const stale = () =>
      satiJson<{ stale: boolean | null }[]>(dir, "context", "get").data.map((e) => e.stale);
    expect(stale()).toEqual([false]);

    writeFileSync(join(dir, "other.ts"), "y\n");
    gitWithSati(dir, "add", "-A");
    expect(stale()).toEqual([false]);

    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
    gitWithSati(dir, "add", "-A");
    expect(stale()).toEqual([true]);
    expect(sati(dir, "context", "get").stdout).toContain("[STALE]");
    expect(sati(dir, "brief").stdout).toContain("## Stale context");

    sati(dir, "context", "put", "src", "--summary", "Source tree, re-read");
    expect(stale()).toEqual([false]);
  }, 30_000);
});
