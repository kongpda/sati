import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateDb, SqliteStore } from "@sati/store-sqlite";
import { describe, expect, it } from "vitest";
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

interface Rec {
  id: string;
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i}`)
    .join("\n")
    .concat("\n");

/** A repo whose committed `src/billing` belongs to a shipped feature. */
async function billingRepo(protect = true): Promise<{ dir: string; feature: Rec }> {
  const dir = await tempRepo({ init: true });
  mkdirSync(join(dir, "src/billing"), { recursive: true });
  writeFileSync(join(dir, "src/billing/invoice.ts"), lines(10));
  writeFileSync(join(dir, "src/billing/tax.ts"), lines(10));
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  const args = ["feature", "create", "Billing", "--status", "shipped", "--paths", "src/billing/**"];
  const feature = satiJson<Rec>(dir, ...args, ...(protect ? ["--protected"] : [])).data;
  return { dir, feature };
}

async function guardRows(dir: string) {
  const store = await SqliteStore.open(locateDb(dir).path);
  try {
    const rows = await store.read(async (r) => {
      const project = await r.getProject();
      return project ? r.listActivity(project.id) : [];
    });
    return rows.filter((a) => a.verb === "guard");
  } finally {
    await store.close();
  }
}

// PLAN gate: "a staged deletion of a protected feature is blocked".
describe("sati guard --staged", () => {
  it("blocks a staged deletion of a protected feature until a decision lists it", async () => {
    const { dir, feature } = await billingRepo();
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    const blocked = sati(dir, "guard", "--staged");
    expect(blocked.code).toBe(10);
    expect(blocked.stdout).toContain("blocked: This deletes src/billing/invoice.ts");
    expect(blocked.stdout).toContain("SATI_GUARD=off");

    sati(
      dir,
      "decision",
      "record",
      "Drop invoices",
      "--decision",
      "Moved out.",
      "--features",
      feature.id,
    );
    const allowed = satiJson<{ verdict: string }>(dir, "guard", "--staged");
    expect(allowed).toMatchObject({ code: 0, data: { verdict: "warn" } });
  });

  it("is off in a general project, and back on when it is a code project again", async () => {
    const { dir } = await billingRepo();
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    sati(dir, "settings", "--kind", "general");
    expect(sati(dir, "guard", "--staged")).toMatchObject({ code: 0, stdout: "Guard: ok.\n" });
    sati(dir, "settings", "--kind", "code");
    expect(sati(dir, "guard", "--staged").code).toBe(10);
  });

  // PLAN Phase 9: the guard was off in a general project, so a signed-off deck had no protection.
  it("guards an approved file in a general project by its bytes", async () => {
    const { dir } = await billingRepo();
    sati(dir, "settings", "--kind", "general");
    writeFileSync(join(dir, "deck.pptx"), "version one");
    expect(sati(dir, "card", "approve", "deck.pptx").stdout).toContain("Approved");
    expect(sati(dir, "card", "get", "deck.pptx").stdout).toContain("[approved]");
    // An agent asks before it edits: blocked, whatever the bytes are now.
    const asked = sati(dir, "guard", "--paths", "deck.pptx");
    expect(asked.code).toBe(10);
    expect(asked.stdout).toContain("deck.pptx was approved by");
    // Staged with the approved bytes it passes; with other bytes it does not.
    git(dir, "add", "deck.pptx");
    expect(sati(dir, "guard", "--staged")).toMatchObject({ code: 0, stdout: "Guard: ok.\n" });
    writeFileSync(join(dir, "deck.pptx"), "version two");
    git(dir, "add", "deck.pptx");
    expect(sati(dir, "guard", "--staged").code).toBe(10);
    expect(sati(dir, "card", "get", "deck.pptx").stdout).toContain("CHANGED since it was approved");
    // The cleanup never drops the card of a missing approved file.
    rmSync(join(dir, "deck.pptx"));
    git(dir, "rm", "-q", "--cached", "deck.pptx");
    sati(dir, "doctor", "--fix");
    expect(sati(dir, "card", "get", "deck.pptx").stdout).toContain("approved file is MISSING");
    expect(sati(dir, "card", "approve", "deck.pptx").code).toBe(3);
    expect(sati(dir, "card", "approve", "deck.pptx", "--clear").code).toBe(0);
    expect(sati(dir, "guard", "--paths", "deck.pptx").code).toBe(0);
  });

  it("blocks gutting a protected feature, warns on a small edit, passes unrelated files", async () => {
    const { dir } = await billingRepo();
    writeFileSync(join(dir, "README.md"), "changed\n");
    git(dir, "add", "README.md");
    expect(sati(dir, "guard", "--staged")).toMatchObject({ code: 0, stdout: "Guard: ok.\n" });

    // 9 of the 20 lines of the feature's changed files: under half.
    writeFileSync(join(dir, "src/billing/invoice.ts"), "line 0\n");
    writeFileSync(join(dir, "src/billing/tax.ts"), lines(10).concat("more\n"));
    git(dir, "add", ".");
    expect(sati(dir, "guard", "--staged").code).toBe(0);

    // One line left in each file: 18 of 20 lines removed, and no file emptied.
    writeFileSync(join(dir, "src/billing/tax.ts"), "line 0\n");
    git(dir, "add", ".");
    const r = sati(dir, "guard", "--staged");
    expect(r.code).toBe(10);
    expect(r.stdout).toContain("removes 90% of the changed lines");
  });

  // Review WP10: one changed line of a big file used to hide an emptied small file in the
  // feature's total. git's added-line count now marks the emptied file, and it is blocked.
  it("blocks emptying a protected file even when a big file's edit dilutes the total", async () => {
    const { dir } = await billingRepo();
    writeFileSync(join(dir, "src/billing/big.ts"), lines(5000));
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "big");
    writeFileSync(join(dir, "src/billing/big.ts"), lines(4999));
    writeFileSync(join(dir, "src/billing/tax.ts"), "");
    git(dir, "add", ".");
    const r = sati(dir, "guard", "--staged");
    expect(r.code).toBe(10);
    expect(r.stdout).toContain("empties src/billing/tax.ts");
  });

  it("SATI_GUARD=off lets a blocked commit through and logs the override", async () => {
    const { dir, feature } = await billingRepo();
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    const r = run(dir, ["guard", "--staged"], { SATI_GUARD: "off" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("let through by SATI_GUARD=off");
    expect(await guardRows(dir)).toEqual([
      expect.objectContaining({
        entityId: feature.id,
        diff: expect.objectContaining({ rule: "protected-delete", override: true }),
      }),
    ]);
  });

  // PLAN: touching a shipped, unprotected feature warns, and an activity entry is written.
  it("warns on an unprotected shipped feature and logs it", async () => {
    const { dir } = await billingRepo(false);
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    const r = sati(dir, "guard", "--staged");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'warning: src/billing/invoice.ts belongs to shipped feature "Billing"',
    );
    expect(await guardRows(dir)).toHaveLength(1);
  });
});

describe("sati guard --paths and --hook", () => {
  it("--paths blocks a file in another agent's exclusive lock", async () => {
    const dir = await tempRepo({ init: true });
    run(dir, ["lock", "acquire", "src/auth/**"], { SATI_ACTOR: "other" });
    const r = sati(dir, "guard", "--paths", "src/auth/login.ts,README.md");
    expect(r.code).toBe(10);
    expect(r.stdout).toContain("src/auth/login.ts is inside an exclusive lock held by other");
    expect(sati(dir, "guard").code).toBe(2);
  });

  // Claude Code reads exit 2 as "block the tool call" and shows stderr to the agent.
  // Why: every Bash call paid for opening the database; a command that changes nothing guarded
  // must not even need a project, so it passes in a repo with no sati.
  it("--hook lets a harmless Bash command through without opening a project", async () => {
    const dir = await tempRepo();
    const r = spawnSync(process.execPath, [bin, "guard", "--hook"], {
      cwd: dir,
      encoding: "utf8",
      input: JSON.stringify({ cwd: dir, tool_input: { command: "ls -la" } }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("--hook blocks an Edit inside a lock with exit 2, and passes warnings as context", async () => {
    const { dir } = await billingRepo(false);
    run(dir, ["lock", "acquire", "src/auth"], { SATI_ACTOR: "other" });
    const hook = (file_path: string) =>
      execFileSync(process.execPath, [bin, "guard", "--hook"], {
        cwd: dir,
        env: { ...process.env, SATI_ACTOR: "tester" },
        input: JSON.stringify({ cwd: dir, tool_name: "Edit", tool_input: { file_path } }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    let err: { status: number; stderr: string } | undefined;
    try {
      hook(join(dir, "src/auth/x.ts"));
    } catch (e) {
      err = e as { status: number; stderr: string };
    }
    expect(err?.status).toBe(2);
    expect(err?.stderr).toContain("held by other");

    const warn = JSON.parse(hook(join(dir, "src/billing/tax.ts")));
    expect(warn.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse" });
    expect(warn.hookSpecificOutput.additionalContext).toContain("shipped feature");
    expect(hook(join(dir, "README.md"))).toBe("");
    expect(hook("/etc/hosts")).toBe("");
  });

  // A Bash call that moves a guarded file out of the repo, or skips the git hooks, is blocked.
  it("--hook blocks moving a protected file out of the repo and --no-verify commits", async () => {
    const { dir } = await billingRepo();
    const bash = (command: string) =>
      run(dir, ["guard", "--hook"], {}, JSON.stringify({ cwd: dir, tool_input: { command } }));
    const moved = bash("mv src/billing/invoice.ts /tmp/invoice.ts");
    expect(moved.code).toBe(2);
    expect(moved.stderr).toContain("src/billing/invoice.ts");
    const skipped = bash("git commit -am wip --no-verify");
    expect(skipped.code).toBe(2);
    expect(skipped.stderr).toContain("--no-verify");
    expect(bash("mv README.md /tmp/readme.md").code).toBe(0);
  });

  // Review WP10: the repo root resolved to no path at all, so `rm -rf .` passed the hook.
  it("--hook blocks removing the whole repo, by `.` or by its absolute path", async () => {
    const { dir } = await billingRepo();
    const bash = (command: string, cwd = dir) =>
      run(dir, ["guard", "--hook"], {}, JSON.stringify({ cwd, tool_input: { command } }));
    // In sh a backslash is an escape, so a Windows path is written with `/` (C:/Users/...).
    const abs = dir.replaceAll("\\", "/");
    for (const command of ["rm -rf .", `rm -rf ${abs}`, "cd src && rm -rf .."]) {
      const r = bash(command);
      expect(r.code, command).toBe(2);
      expect(r.stderr, command).toContain("deletes src");
    }
    expect(bash("rm -rf .", join(dir, "src/billing")).code).toBe(2);
  });
});
