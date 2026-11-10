import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { planHooks, selfCommand } from "../src/hooks.js";
import { run, sati, satiJson, tempRepo } from "./helpers.js";

interface Init {
  files: { path: string; action: string }[];
  notes: string[];
}

const which = (cmd: string) =>
  dirname(
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" })
      .split(/\r?\n/u)[0]
      ?.trim() ?? "",
  );
/** A PATH with node and git but no `sati`, so a hook that looks sati up by name fails. */
const NO_SATI_PATH = [
  ...new Set([dirname(process.execPath), which("git"), "/usr/bin", "/bin"]),
].join(delimiter);

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
    // Windows has no execute bit; git runs hooks there through its own sh.
    if (process.platform !== "win32")
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

  // Why: a begin marker with no end marker made every upgrade stack another block.
  it("refuses a hook with an unterminated sati block and names the file", async () => {
    const dir = await tempRepo();
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    const broken = "#!/bin/sh\n# >>> sati\necho half\n";
    writeFileSync(join(dir, ".git/hooks/pre-commit"), broken);
    const r = sati(dir, "init", "--yes", "--tools", "");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("pre-commit");
    expect(read(dir, ".git/hooks/pre-commit")).toBe(broken);
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

  // A moved or removed install must not block commits, and must say how to fix it. The message
  // holds backticks, so it must print literally rather than run as a command.
  it("lets git go on, with a hint, when the recorded sati is gone", async () => {
    const dir = await tempRepo();
    const hook = planHooks(dir, "git", ["/nonexistent/sati"]).find((h) =>
      h.path.split(sep).join("/").endsWith("sati/hooks/pre-commit"),
    );
    if (!hook) throw new Error("no pre-commit runner planned");
    const r = spawnSync("sh", ["-c", hook.content], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe(
      "sati is no longer at /nonexistent/sati, so its git hooks did not run. Run `sati init --upgrade` from the new install.\n",
    );
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

  // PLAN Git sync: a global core.hooksPath is the hooks folder of every repo on the machine, so
  // `init --yes` never writes there; it says so, and `--global-hooks` opts in.
  it("leaves a global core.hooksPath alone unless --global-hooks is given", async () => {
    const dir = await tempRepo();
    const home = realpathSync.native(mkdtempSync(join(tmpdir(), "sati-global-")));
    const folder = join(home, "hooks").split(sep).join("/");
    mkdirSync(folder);
    const theirs = "#!/bin/sh\necho global\n";
    writeFileSync(join(folder, "pre-commit"), theirs);
    writeFileSync(join(home, "gitconfig"), `[core]\n\thooksPath = ${folder}\n`);
    const env = { GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
    const json = (...args: string[]) => {
      const r = run(dir, [...args, "--json"], env);
      expect(r.code).toBe(0);
      return JSON.parse(r.stdout) as Init;
    };

    const first = json("init", "--yes", "--tools", "");
    expect(first.files).toContainEqual({ path: `${folder}/pre-commit`, action: "skip" });
    expect(first.files).toContainEqual({ path: `${folder}/pre-push`, action: "skip" });
    expect(first.files.some((f) => f.path.startsWith(".git/hooks/"))).toBe(false);
    expect(first.notes).toEqual([
      `(${folder}/pre-commit: git uses the global core.hooksPath ${folder} for every repo on this machine, so sati did not write there and its git hooks will not run in this repo. To chain them into that folder (they do nothing in repos without sati), run \`sati init --upgrade --global-hooks\`)`,
    ]);
    expect(read(folder, "pre-commit")).toBe(theirs);
    expect(existsSync(join(folder, "post-merge"))).toBe(false);
    // The human output prints the warning too.
    const upgrade = run(dir, ["init", "--upgrade", "--yes"], env);
    expect(upgrade.stdout).toContain(`git uses the global core.hooksPath ${folder}`);
    expect(read(folder, "pre-commit")).toBe(theirs);

    const opted = json("init", "--upgrade", "--yes", "--global-hooks");
    expect(opted.files).toContainEqual({ path: `${folder}/pre-commit`, action: "update" });
    expect(opted.files).toContainEqual({ path: `${folder}/post-merge`, action: "create" });
    expect(opted.notes).toEqual([]);
    expect(read(folder, "pre-commit")).toMatch(
      /^#!\/bin\/sh\n# >>> sati[\s\S]*# <<< sati\necho global\n$/,
    );
  });

  // A block of sh lines would break a hook written for another interpreter, so it is reported.
  it("leaves a hook in another language byte-identical and says how to call sati from it", async () => {
    const dir = await tempRepo();
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    const theirs =
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync('.git/theirs-ran', '');\n";
    writeFileSync(join(dir, ".git/hooks/pre-commit"), theirs);
    const r = init(dir);
    expect(r.data.files).toContainEqual({ path: ".git/hooks/pre-commit", action: "skip" });
    expect(r.data.files).toContainEqual({ path: ".git/hooks/post-merge", action: "create" });
    expect(r.data.notes).toEqual([
      "(.git/hooks/pre-commit: this hook runs with node, not sh, so sati left it unchanged. Have it run .git/sati/hooks/pre-commit with the same arguments, and stop when it fails)",
    ]);
    expect(read(dir, ".git/hooks/pre-commit")).toBe(theirs);

    const again = satiJson<Init>(dir, "init", "--upgrade", "--yes");
    expect(again.data.files).toContainEqual({ path: ".git/hooks/pre-commit", action: "skip" });
    expect(read(dir, ".git/hooks/pre-commit")).toBe(theirs);
  });
});

describe("selfCommand", () => {
  // Windows has no execute bit: accessSync X_OK passes for any file, and a hook cannot run a
  // .js file directly. sati must run itself through node there.
  it("runs the script through node on Windows, even when it looks executable", () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-self-"));
    const script = join(dir, "sati.js");
    writeFileSync(script, "", { mode: 0o755 });
    const { argv, platform } = process;
    process.argv = [argv[0] ?? "", script];
    try {
      expect(selfCommand(dir)).toEqual([script]);
      Object.defineProperty(process, "platform", { value: "win32" });
      expect(selfCommand(dir)).toEqual([process.execPath, script]);
    } finally {
      Object.defineProperty(process, "platform", { value: platform });
      process.argv = argv;
    }
  });
});
