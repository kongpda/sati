import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCheck } from "../src/build-check.js";

const bin = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const run = (...args: string[]) =>
  execFileSync(process.execPath, [bin, ...args], { encoding: "utf8" }).trim();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

describe("sati --version", () => {
  // Phase 0 gate: the published binary must start and report the package version. Every build
  // of one version said the same number, so the commit it was built from follows after `+`.
  it("prints the package version and the commit the bundle was built from", () => {
    const out = run("--version");
    const [version, build] = out.split("+");
    expect(version).toBe(pkg.version);
    // This test runs from a checkout, so the build is stamped; the bundle was built from HEAD.
    const head = git(fileURLToPath(new URL("..", import.meta.url)), "rev-parse", "HEAD");
    expect(build).toMatch(/^[0-9a-f]{7,}(\.dirty)?$/u);
    expect(head.startsWith((build ?? "").split(".")[0] ?? "x")).toBe(true);
  });

  // node, npm and pnpm answer `-v`; many other tools answer `-V`. Neither means anything else here.
  it("answers -v and -V with the same line", () => {
    expect(run("-v")).toBe(run("--version"));
    expect(run("-V")).toBe(run("--version"));
  });
});

// A source install runs the bundle in the checkout. After `git pull` the command still runs the
// old code, and nothing said so: `doctor` must tell a stale build from a fresh one.
describe("the build check in doctor", () => {
  /** A checkout shaped like this repo, with one commit; returns its dist folder. */
  function checkout() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sati-build-")));
    mkdirSync(join(root, "packages", "cli", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "cli", "dist"), { recursive: true });
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "packages", "cli", "src", "a.ts"), "export const a = 1;\n");
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    return { root, dist: join(root, "packages", "cli", "dist") };
  }
  const commit = (root: string, file: string) => {
    writeFileSync(join(root, file), `${Math.random()}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", file);
  };

  it("passes for the commit it was built from, and after a commit that changes no code", () => {
    const { root, dist } = checkout();
    const sha = git(root, "rev-parse", "--short=7", "HEAD");
    expect(buildCheck(sha, dist)).toMatchObject({ name: "build", ok: true });
    // Docs and task records change with every piece of work; they do not make a build old.
    commit(root, "docs/notes.md");
    expect(buildCheck(sha, dist)).toMatchObject({ ok: true });
  });

  it("fails with the command to run once the source has newer code", () => {
    const { root, dist } = checkout();
    const sha = git(root, "rev-parse", "--short=7", "HEAD");
    commit(root, "packages/cli/src/a.ts");
    const check = buildCheck(sha, dist);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain(`Built from ${sha}`);
    expect(check?.detail).toContain("pnpm build");
    // A commit this checkout does not have (a rebase, another clone) cannot be called current.
    expect(buildCheck("0123abc", dist)).toMatchObject({ ok: false });
  });

  it("says a build with uncommitted changes is one, and stays out of an installed package", () => {
    const { root, dist } = checkout();
    const sha = git(root, "rev-parse", "--short=7", "HEAD");
    expect(buildCheck(`${sha}.dirty`, dist)).toMatchObject({
      ok: true,
      detail: expect.stringContaining("not committed"),
    });
    // No stamp (built outside git), or a bundle that is not inside the source: nothing to say.
    expect(buildCheck("", dist)).toBeUndefined();
    expect(buildCheck(sha, join(root, "elsewhere", "node_modules", "pkg", "dist"))).toBeUndefined();
  });
});
