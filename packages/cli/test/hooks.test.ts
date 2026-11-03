import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sati, satiJson, tempRepo } from "./helpers.js";

interface Init {
  files: { path: string; action: string }[];
}

const which = (cmd: string) => dirname(execFileSync("which", [cmd], { encoding: "utf8" }).trim());
/** A PATH with node and git but no `sati`, so a hook that looks sati up by name fails. */
const NO_SATI_PATH = [...new Set([which("node"), which("git"), "/usr/bin", "/bin"])].join(":");

function commit(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: NO_SATI_PATH, SATI_ACTOR: "tester" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const init = (dir: string, ...args: string[]) =>
  satiJson<Init>(dir, "init", "--yes", "--tools", "", ...args);

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");

describe("git hooks", () => {
  // PLAN Security: hooks start sati by the absolute path recorded at init, so a repo cannot swap
  // in another `sati` through PATH; here PATH has no sati at all and the hooks still run.
  it("run sati by its recorded path, guarding shipped features and committing the snapshot", async () => {
    const dir = await tempRepo();
    const r = init(dir);
    expect(r.data.files).toContainEqual({ path: ".git/hooks/pre-commit", action: "create" });
    expect(statSync(join(dir, ".git/hooks/pre-commit")).mode & 0o111).not.toBe(0);

    mkdirSync(join(dir, "src/billing"), { recursive: true });
    writeFileSync(join(dir, "src/billing/a.ts"), "a\nb\nc\n");
    git(dir, "add", ".");
    commit(dir, "-qm", "a");
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toContain(
      ".sati/sati.config.json",
    );

    sati(
      dir,
      "feature",
      "create",
      "Billing",
      "--status",
      "shipped",
      "--protected",
      "--paths",
      "src/billing",
    );
    git(dir, "rm", "-q", "src/billing/a.ts");
    expect(() => commit(dir, "-qm", "rm")).toThrow(/protected feature/);
  });

  // PLAN review fix 5: never overwrite a hook; chain into it with a marked block.
  it("chains into an existing hook, keeps it running, and never duplicates the block", async () => {
    const dir = await tempRepo();
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(join(dir, ".git/hooks/pre-commit"), "#!/bin/sh\ntouch .git/theirs-ran\n");
    expect(init(dir).data.files).toContainEqual({
      path: ".git/hooks/pre-commit",
      action: "update",
    });
    const hook = read(dir, ".git/hooks/pre-commit");
    expect(hook.startsWith("#!/bin/sh\n# >>> sati")).toBe(true);
    expect(hook.endsWith("# <<< sati\ntouch .git/theirs-ran\n")).toBe(true);

    const again = satiJson<Init>(dir, "init", "--upgrade", "--yes");
    expect(again.data.files).toContainEqual({ path: ".git/hooks/pre-commit", action: "keep" });
    expect(read(dir, ".git/hooks/pre-commit")).toBe(hook);

    const task = satiJson<{ id: string }>(dir, "task", "create", "Chained").data;
    git(dir, "add", "-A");
    commit(dir, "-qm", "both hooks");
    expect(existsSync(join(dir, ".git/theirs-ran"))).toBe(true);
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toContain(
      `.sati/tasks/${task.id}.json`,
    );
  });

  // A whole hook file written by an older sati is ours, so it becomes the new short block.
  it("replaces a hook file an older sati init wrote", async () => {
    const dir = await tempRepo();
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(
      join(dir, ".git/hooks/pre-commit"),
      "#!/bin/sh\n# Installed by `sati init`: old\nexec sati guard --staged\n",
    );
    expect(init(dir).data.files).toContainEqual({
      path: ".git/hooks/pre-commit",
      action: "update",
    });
    const hook = read(dir, ".git/hooks/pre-commit");
    expect(hook).not.toContain("exec sati guard");
    expect(hook).toContain('"$(git rev-parse --git-common-dir)/sati/hooks/pre-commit"');
    expect(read(dir, ".git/sati/hooks/pre-commit")).toContain("sati sync export");
  });

  // husky 9 regenerates `.husky/_`, so a block there would vanish; the user's `.husky/<hook>`
  // files are where chaining lasts. The block holds no machine path, so it is safe to commit.
  it("chains into husky's own hook files, and leaves them alone in stealth mode", async () => {
    const dir = await tempRepo();
    mkdirSync(join(dir, ".husky/_"), { recursive: true });
    writeFileSync(join(dir, ".husky/pre-commit"), "npx lint-staged\n");
    git(dir, "config", "core.hooksPath", ".husky/_");

    const stealth = await tempRepo();
    mkdirSync(join(stealth, ".husky/_"), { recursive: true });
    writeFileSync(join(stealth, ".husky/pre-commit"), "npx lint-staged\n");
    git(stealth, "config", "core.hooksPath", ".husky/_");
    expect(init(stealth, "--mode", "stealth").data.files).toContainEqual({
      path: ".husky/pre-commit",
      action: "skip",
    });
    expect(read(stealth, ".husky/pre-commit")).toBe("npx lint-staged\n");

    const r = init(dir);
    expect(r.data.files).toContainEqual({ path: ".husky/pre-commit", action: "update" });
    expect(r.data.files).toContainEqual({ path: ".husky/post-merge", action: "create" });
    const hook = read(dir, ".husky/pre-commit");
    expect(hook).toMatch(/^# >>> sati[\s\S]*# <<< sati\nnpx lint-staged\n$/);
    expect(hook).not.toContain(dir);
    expect(existsSync(join(dir, ".husky/_/pre-commit"))).toBe(false);
  });

  // lefthook rewrites the hooks in .git/hooks, and merges lefthook-local.yml into its config.
  it("chains into lefthook through lefthook-local.yml and leaves .git/hooks alone", async () => {
    const dir = await tempRepo();
    writeFileSync(
      join(dir, "lefthook.yml"),
      "pre-commit:\n  commands:\n    lint:\n      run: npm run lint\n",
    );
    const r = init(dir);
    expect(r.data.files).toContainEqual({ path: "lefthook-local.yml", action: "create" });
    expect(r.data.files.some((f) => f.path.startsWith(".git/hooks/"))).toBe(false);
    const local = read(dir, "lefthook-local.yml");
    expect(local).toContain("pre-commit:\n  commands:\n    sati:\n      run: ");
    expect(local).toContain("/sati/hooks/post-merge");

    const other = await tempRepo();
    writeFileSync(join(other, "lefthook.yml"), "{}\n");
    writeFileSync(join(other, "lefthook-local.yml"), "pre-commit: {}\n");
    expect(init(other).data.files).toContainEqual({ path: "lefthook-local.yml", action: "skip" });
    expect(read(other, "lefthook-local.yml")).toBe("pre-commit: {}\n");
  });
});
