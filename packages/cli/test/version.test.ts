import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCheck } from "../src/build-check.js";
import { versionLine } from "../src/version.js";
import { sati, satiJson, tempRepo } from "./helpers.js";

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
  // of one version said the same number, so the commit and its date follow in brackets.
  it("prints the name, the package version, and the commit and date the bundle was built from", () => {
    const here = fileURLToPath(new URL("..", import.meta.url));
    const m = /^sati (\S+) \(([0-9a-f]{7,})(-dirty)? (\d{4}-\d{2}-\d{2})\)$/u.exec(
      run("--version"),
    );
    expect(m?.[1]).toBe(pkg.version);
    // This test runs from a checkout, so the build is stamped; the bundle was built from HEAD.
    expect(git(here, "rev-parse", "HEAD").startsWith(m?.[2] ?? "x")).toBe(true);
    // The commit's date, so the same commit gives the same line on every machine and day.
    expect(m?.[4]).toBe(git(here, "show", "-s", "--format=%cs", "HEAD"));
  });

  it("marks uncommitted changes, and prints the plain version for a build made outside git", () => {
    expect(versionLine("sati", "1.2.3", "a8104c0", "2026-11-11")).toBe(
      "sati 1.2.3 (a8104c0 2026-11-11)",
    );
    expect(versionLine("sati", "1.2.3", "a8104c0.dirty", "2026-11-11")).toBe(
      "sati 1.2.3 (a8104c0-dirty 2026-11-11)",
    );
    expect(versionLine("sati", "1.2.3", "", "")).toBe("sati 1.2.3");
  });

  // The MCP server info and the help title take a version, not a sentence: semver with the
  // commit as build metadata.
  it("keeps the semver form in the help title", () => {
    expect(run("--help")).toMatch(
      new RegExp(`^sati ${pkg.version.replaceAll(".", "\\.")}\\+[0-9a-f]{7,}(\\.dirty)?\\b`, "u"),
    );
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

// A bug report needs more than the version: which node, which system, an installed package or a
// source checkout, and where the records are. `--version` stays one line; doctor carries the rest.
describe("the environment in doctor", () => {
  it("leads the report with the version line, node, the system, the install and the store", async () => {
    const dir = await tempRepo({ init: true });
    const env = satiJson<{ environment: Record<string, string> }>(dir, "doctor").data.environment;
    expect(env).toMatchObject({
      version: run("--version"),
      node: process.version,
      os: `${process.platform} ${process.arch}`,
      // The tests run the bundle inside this checkout.
      install: "source",
      bin,
    });
    expect(env.store).toMatch(/sati\.db$/u);
    const lines = sati(dir, "doctor").stdout.split("\n");
    expect(lines[0]).toBe(run("--version"));
    expect(lines[1]).toBe(`node ${process.version}, ${process.platform} ${process.arch}`);
    expect(lines[3]).toBe(`store: ${env.store}`);
  });
});
