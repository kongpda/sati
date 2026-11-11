import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locateDb } from "@sati/store-sqlite";
import { describe, expect, it } from "vitest";
import { branchInHead, currentBranch, gitRepoIndex } from "../src/runtime.js";
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

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

const home = () => mkdtempSync(join(tmpdir(), "sati-home-"));

/** Pipes a PreToolUse payload to `guard --hook`. */
function hook(cwd: string, hookCwd: string, file: string) {
  return spawnSync(process.execPath, [bin, "guard", "--hook"], {
    cwd,
    env: { ...process.env, SATI_ACTOR: "tester" },
    input: JSON.stringify({ cwd: hookCwd, tool_name: "Edit", tool_input: { file_path: file } }),
    encoding: "utf8",
  });
}

describe("flag parsing", () => {
  // Why: `--project=slug` was ignored, so a command silently ran against the cwd project.
  it("--project=slug selects that project like --project slug", async () => {
    const h = home();
    const repo = await tempRepo();
    const init = JSON.parse(
      run(repo, ["init", "--yes", "--tools", "", "--json"], { HOME: h }).stdout,
    );
    run(repo, ["task", "create", "Elsewhere"], { HOME: h });
    const other = mkdtempSync(join(tmpdir(), "sati-other-"));
    const slug: string = init.project.slug;
    const equals = run(other, [`--project=${slug}`, "task", "list", "--json"], { HOME: h });
    expect(equals.code).toBe(0);
    expect(JSON.parse(equals.stdout)).toEqual(
      JSON.parse(run(other, ["--project", slug, "task", "list", "--json"], { HOME: h }).stdout),
    );
  });

  // Why: citty drops undeclared flags, so a typo like --stauts listed every task unfiltered.
  it("refuses an unknown flag with USAGE and a suggestion", async () => {
    const dir = await tempRepo({ init: true });
    const r = sati(dir, "task", "list", "--stauts", "backlog");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown option --stauts");
    expect(r.stderr).toContain("Did you mean --status?");
    // Declared flags in every accepted spelling still work.
    expect(sati(dir, "task", "list", "--status=todo", "--json").code).toBe(0);
    expect(sati(dir, "task", "list", "--no-ready", "--json").code).toBe(0);
    // After `--` everything is positional, not a flag.
    expect(sati(dir, "task", "create", "--", "-weird title").code).toBe(0);
  });

  // Why: `--no-auto-continue` was computed as "no change" and silently did nothing.
  it("settings --no-auto-continue turns it off", async () => {
    const dir = await tempRepo({ init: true });
    expect(
      satiJson<{ autoContinue: boolean }>(dir, "settings", "--auto-continue").data,
    ).toMatchObject({
      autoContinue: true,
    });
    expect(
      satiJson<{ autoContinue: boolean }>(dir, "settings", "--no-auto-continue").data,
    ).toMatchObject({ autoContinue: false });
  });

  // Why: `Number("1e3")` and `Number("")` passed as integers.
  it("rejects numbers that are not plain integers, and bad --subtasks JSON, as USAGE", async () => {
    const dir = await tempRepo({ init: true });
    expect(sati(dir, "task", "list", "--limit", "1e3").code).toBe(2);
    expect(sati(dir, "task", "list", "--limit", "0x10").code).toBe(2);
    const bad = satiJson<{ error: { code: string } }>(
      dir,
      "task",
      "create",
      "T",
      "--subtasks",
      "{nope",
    );
    expect(bad.code).toBe(2);
    expect(bad.data.error.code).toBe("USAGE");
  });
});

describe("guard path handling", () => {
  // Why: with a symlinked cwd every path looked outside the repo and the guard passed silently.
  it("--hook still blocks when the hook cwd is a symlink to the repo", async () => {
    const dir = await tempRepo({ init: true });
    run(dir, ["lock", "acquire", "src/auth"], { SATI_ACTOR: "other" });
    const link = join(mkdtempSync(join(tmpdir(), "sati-link-")), "repo");
    symlinkSync(dir, link);
    const r = hook(dir, link, join(link, "src/auth/new-file.ts"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("held by other");
  });

  // Why: `rel.startsWith("..")` treated a file named `..foo` as outside the repo.
  it("--hook checks a file whose name starts with two dots", async () => {
    const dir = await tempRepo({ init: true });
    run(dir, ["lock", "acquire", "..foo"], { SATI_ACTOR: "other" });
    const r = hook(dir, dir, join(dir, "..foo"));
    expect(r.status).toBe(2);
  });
});

/** A repo with a protected 100-line file on main, then a branch that removes `drop` lines. */
async function branchRepo(drop: number, viaCli = false) {
  const dir = await tempRepo({ init: !viaCli });
  if (viaCli) expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
  mkdirSync(join(dir, "src/billing"), { recursive: true });
  writeFileSync(join(dir, "src/billing/invoice.ts"), lines(100));
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  const f = ["feature", "create", "Billing", "--status", "shipped", "--paths", "src/billing/**"];
  sati(dir, ...f, "--protected");
  git(dir, "checkout", "-qb", "feat");
  writeFileSync(join(dir, "src/billing/invoice.ts"), lines(100 - drop));
  // SATI_GUARD=off: the commit hook would block the removal that the push-time check must catch.
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "trim", "--allow-empty"],
    {
      cwd: dir,
      env: { ...process.env, SATI_GUARD: "off" },
      stdio: "ignore",
    },
  );
  return dir;
}

describe("range checks", () => {
  // Why: the removal ratio used the range tip's line count, not the base's, so removing 45 of
  // 100 lines (45%) read as 45 of 55 (82%) and a legitimate push was blocked.
  it("measures removals against the range base, not the tip", async () => {
    const dir = await branchRepo(45);
    expect(sati(dir, "guard", "--range", "main...HEAD").code).toBe(0);
    const gutted = await branchRepo(60);
    expect(sati(gutted, "guard", "--range", "main...HEAD").code).toBe(10);
  });

  // Why: the range reached `git diff` unchecked, so `--output=<file>` wrote a file.
  it("review refuses a range that looks like a git option", async () => {
    const dir = await tempRepo({ init: true });
    git(dir, "commit", "-q", "--allow-empty", "-m", "root");
    const out = join(dir, "pwned.txt");
    const r = sati(dir, "review", "--", `--output=${out}`);
    expect(r.code).toBe(2);
    expect(existsSync(out)).toBe(false);
    expect(sati(dir, "guard", "--range", "--output=x").code).toBe(2);
  });

  // Why: review treated every path as an edit, so a deleted protected file was only a warning.
  it("review classifies deletions like guard --range", async () => {
    const dir = await branchRepo(0);
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    git(dir, "commit", "-qm", "drop");
    const r = satiJson<{ guard: { verdict: string } }>(dir, "review", "main...HEAD");
    expect(r.data.guard.verdict).toBe("blocked");
  });

  // Why: non-ASCII names come back quoted from `git diff --name-only` without -z.
  it("review lists non-ASCII file names unquoted", async () => {
    const dir = await tempRepo({ init: true });
    git(dir, "commit", "-q", "--allow-empty", "-m", "root");
    git(dir, "checkout", "-qb", "feat");
    writeFileSync(join(dir, "naïve.ts"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "add");
    const r = satiJson<{ paths: string[] }>(dir, "review", "main...HEAD");
    expect(r.data.paths).toEqual(["naïve.ts"]);
  });

  // Why: a repo whose default branch is not main was never guarded on push.
  it("the pre-push runner compares with origin/HEAD, not only origin/main", async () => {
    const dir = await branchRepo(60, true);
    git(dir, "update-ref", "refs/remotes/origin/trunk", "main");
    git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    const common = git(dir, "rev-parse", "--git-common-dir").trim();
    const runner = join(dir, common, "sati", "hooks", "pre-push");
    const r = spawnSync("sh", [runner], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(10);
  });

  /** A bare origin that already has `main`, so the push checks have a base. */
  function withOrigin(dir: string): void {
    const remote = mkdtempSync(join(tmpdir(), "sati-origin-"));
    git(remote, "init", "-q", "--bare");
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "origin", "main");
    git(dir, "fetch", "-q", "origin");
  }
  const push = (dir: string, ...args: string[]) =>
    spawnSync("git", ["push", "-q", "origin", ...args], { cwd: dir, encoding: "utf8" });

  // Why: the runner checked origin/main...HEAD, so `git push origin feat` from main pushed a
  // gutted feature unchecked.
  it("the pre-push hook checks the branch being pushed, not HEAD", async () => {
    const dir = await branchRepo(60, true);
    withOrigin(dir);
    git(dir, "checkout", "-q", "main");
    const r = push(dir, "feat");
    expect(r.status).not.toBe(0);
    expect(git(dir, "ls-remote", "origin", "feat")).toBe("");
  }, 30_000);

  // Why: the runner reads the pushed refs from stdin, which a hook line after ours (such as
  // `git lfs pre-push`) needs as well.
  it("a user's own pre-push lines still get the pushed refs", async () => {
    const dir = await branchRepo(0, true);
    withOrigin(dir);
    const hookFile = join(dir, ".git", "hooks", "pre-push");
    const seen = join(dir, ".git", "seen-refs");
    writeFileSync(hookFile, `${readFileSync(hookFile, "utf8")}cat > '${seen}'\n`);
    const r = push(dir, "feat");
    expect(r.status).toBe(0);
    expect(readFileSync(seen, "utf8")).toMatch(
      /^refs\/heads\/feat [0-9a-f]+ refs\/heads\/feat 0+$/mu,
    );
  }, 30_000);

  it("the pre-push runner says so when there is nothing to compare with", async () => {
    const dir = await tempRepo();
    git(dir, "commit", "-q", "--allow-empty", "-m", "root");
    expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
    const common = git(dir, "rev-parse", "--git-common-dir").trim();
    const r = spawnSync("sh", [join(dir, common, "sati", "hooks", "pre-push")], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("not guarded");
  });
});

describe("commands", () => {
  // Why: a failed check printed "fail" but exited 0, so CI read a broken project as healthy.
  it("doctor exits non-zero when a check fails", async () => {
    const dir = await tempRepo({ init: true }); // no `sati init`, so this clone has no hooks
    const r = sati(dir, "doctor");
    expect(r.stdout).toContain("fail hooks");
    expect(r.code).not.toBe(0);
  });

  // Deep review 2026-11-11: a repo inside Dropbox or OneDrive looks like a local disk, and the
  // database under .git was synced while written. Nothing said so.
  it("init and doctor warn when the database is in a file-sync folder", async () => {
    const dir = join(await tempRepo(), "Dropbox", "launch");
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const init = sati(dir, "init", "--yes", "--tools", "");
    expect(init.code, init.stderr).toBe(0);
    expect(init.stderr).toContain("Dropbox keeps in sync");
    const doctor = sati(dir, "doctor");
    expect(doctor.stdout).toContain("fail synced folder");
    expect(doctor.code).not.toBe(0);
  });

  // Why: running `scan --apply` twice created every feature twice.
  it("scan --apply is idempotent and skips build output folders", async () => {
    const dir = await tempRepo({ init: true });
    for (const d of ["lib", "build", "vendor"]) {
      mkdirSync(join(dir, d));
      writeFileSync(join(dir, d, "a.ts"), "x\n");
    }
    expect(sati(dir, "scan", "--apply").code).toBe(0);
    expect(sati(dir, "scan", "--apply").code).toBe(0);
    const features = satiJson<{ title: string }[]>(dir, "feature", "list").data;
    expect(features.map((f) => f.title)).toEqual(["lib"]);
  });

  // Why: git hooks run `sync import` on every checkout; "Imported 0" there is noise.
  it("sync import --quiet prints nothing when nothing changed", async () => {
    const dir = await tempRepo();
    git(dir, "commit", "-q", "--allow-empty", "-m", "root");
    expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
    const quiet = sati(dir, "sync", "import", "--quiet");
    expect(quiet).toMatchObject({ code: 0, stdout: "" });
    expect(sati(dir, "sync", "import").stdout).toContain("Imported 0");
  });

  // Why: the project was registered after the import, so a failed import left it unregistered.
  it("init registers the project even when the snapshot import fails", async () => {
    const h = home();
    const origin = await tempRepo();
    git(origin, "commit", "-q", "--allow-empty", "-m", "root");
    run(origin, ["init", "--yes", "--tools", ""], { HOME: h });
    run(origin, ["task", "create", "Shared"], { HOME: h });
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "snap");
    const clone = join(mkdtempSync(join(tmpdir(), "sati-clone-")), "b");
    git(origin, "clone", "-q", origin, clone);
    const tasks = join(clone, ".sati", "tasks");
    for (const f of readdirSync(tasks)) writeFileSync(join(tasks, f), "{not json");
    const h2 = home();
    const r = run(clone, ["init", "--yes", "--tools", ""], { HOME: h2 });
    expect(r.code).not.toBe(0);
    const known = JSON.parse(readFileSync(join(h2, ".sati", "projects.json"), "utf8"));
    expect(known).toHaveLength(1);
  });
});

describe("serve command", () => {
  // Why: a second `sati serve` unlinked the live daemon's socket, orphaning its clients.
  it("refuses to start while another serve is live", async () => {
    const dir = await tempRepo({ init: true });
    const first = spawn(process.execPath, [bin, "serve"], {
      cwd: dir,
      env: { ...process.env, SATI_ACTOR: "tester" },
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        first.once("error", reject);
        first.once("exit", () => reject(new Error("serve exited early")));
        first.stdout.on("data", (d: Buffer) => d.toString().includes("serve") && resolve());
      });
      const second = sati(dir, "serve");
      expect(second.code).toBe(4);
      expect(second.stderr).toContain("already running");
    } finally {
      first.kill("SIGTERM");
    }
  }, 30_000);
});

describe("ui command", () => {
  // Why: an out-of-range port was only rejected after the DB opened and a server tried to bind.
  it("rejects a port outside 1-65535 as USAGE", async () => {
    const dir = await tempRepo({ init: true });
    expect(sati(dir, "ui", "--no-open", "--port", "70000").code).toBe(2);
    expect(sati(dir, "ui", "--no-open", "--port", "0").code).toBe(2);
  });
});

describe("gitRepoIndex", () => {
  // Why: one untracked folder (EISDIR on read) made the catch drop every dirty-file hash, so
  // an edited file kept its stale index blob and its context entry never went stale.
  it("still hashes edited files when an untracked folder is present", async () => {
    const dir = await tempRepo();
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "a");
    const before = (await gitRepoIndex(dir).files()).find((f) => f.path === "a.txt");
    writeFileSync(join(dir, "a.txt"), "two\n");
    mkdirSync(join(dir, "fresh"));
    writeFileSync(join(dir, "fresh", "x.txt"), "x\n");
    const after = (await gitRepoIndex(dir).files()).find((f) => f.path === "a.txt");
    expect(after?.blob).not.toBe(before?.blob);
    // Deep review 2026-11-11: an edited file had its own kind of hash, so a card saved before
    // the commit read stale after it, though nothing changed. It now has the id git will give.
    git(dir, "add", "a.txt");
    git(dir, "commit", "-qm", "two");
    const committed = (await gitRepoIndex(dir).files()).find((f) => f.path === "a.txt");
    expect(committed?.blob).toBe(after?.blob);
    // Recall lifts the card of a file being edited; it reads this flag.
    expect(before?.dirty).toBeUndefined();
    expect(after?.dirty).toBe(true);
  });
});

describe("currentBranch", () => {
  // Why: every command stamps its activity rows with the branch. It is read from the HEAD file
  // to save a git start per command; a wrong answer there would file work under the wrong branch.
  it("reads the branch of the checkout it runs in, also in a linked worktree", async () => {
    const dir = await tempRepo();
    expect(currentBranch(locateDb(dir))).toBe("main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "a");
    git(dir, "switch", "-qc", "feat/login");
    expect(currentBranch(locateDb(dir))).toBe("feat/login");

    const tree = join(mkdtempSync(join(tmpdir(), "sati-tree-")), "wt");
    git(dir, "worktree", "add", "-qb", "side", tree);
    const side = locateDb(tree);
    expect(side.path).toBe(locateDb(dir).path);
    expect(currentBranch(side)).toBe("side");
    expect(currentBranch(locateDb(dir))).toBe("feat/login");

    git(dir, "checkout", "-q", "--detach");
    expect(currentBranch(locateDb(dir))).toBeNull();
  });

  it("tells a branch, a detached HEAD and an unreadable HEAD apart", () => {
    expect(branchInHead("ref: refs/heads/feat/x\n")).toBe("feat/x");
    expect(branchInHead(`${"a".repeat(40)}\n`)).toBeNull();
    // A reftable repository keeps a placeholder here: the caller must ask git.
    expect(branchInHead("ref: refs/heads/.invalid\n")).toBeUndefined();
    expect(branchInHead("")).toBeUndefined();
  });
});

describe("mcp process", () => {
  // Why: SIGTERM killed the server inside the 2 s export debounce, leaving `.sati/` stale.
  // Windows has no catchable SIGTERM: kill() ends the process at once. The records stay in the
  // database, and the next start or pre-commit hook exports them.
  it.skipIf(process.platform === "win32")(
    "flushes the .sati/ export on SIGTERM",
    async () => {
      const dir = await tempRepo();
      git(dir, "commit", "-q", "--allow-empty", "-m", "root");
      expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
      const child = spawn(process.execPath, [bin, "mcp"], {
        cwd: dir,
        env: { ...process.env, SATI_ACTOR: "tester" },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
      let buf = "";
      const seen = (id: number) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (buf.split("\n").some((l) => l.includes(`"id":${id}`))) resolve();
          };
          child.stdout.on("data", (d: Buffer) => {
            buf += d.toString();
            check();
          });
          check();
        });
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      });
      await seen(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "task_create", arguments: { title: "Exported on exit" } },
      });
      await seen(2);
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
      const tasks = join(dir, ".sati", "tasks");
      expect(existsSync(tasks) ? readdirSync(tasks).length : 0).toBeGreaterThan(0);
    },
    20_000,
  );
});
