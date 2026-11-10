import { describe, expect, it } from "vitest";
import { hookBypass, parseShellChanges } from "../src/index.js";

describe("parseShellChanges", () => {
  // PLAN: PreToolUse matches Bash and turns rm, git rm and mv into guard changes.
  it("reads deletes and renames through flags, quotes and chains", () => {
    expect(parseShellChanges("rm -rf -- src/a.ts 'src/b c.ts'")).toEqual([
      { path: "src/a.ts", kind: "deleted" },
      { path: "src/b c.ts", kind: "deleted" },
    ]);
    expect(parseShellChanges("git rm -f src/a.ts && mv src/old.ts src/new.ts")).toEqual([
      { path: "src/a.ts", kind: "deleted" },
      { path: "src/new.ts", kind: "renamed", from: "src/old.ts" },
    ]);
    expect(parseShellChanges("mv src/a.ts src/b.ts dest/")).toEqual([
      { path: "dest/a.ts", kind: "renamed", from: "src/a.ts" },
      { path: "dest/b.ts", kind: "renamed", from: "src/b.ts" },
    ]);
  });

  it("ignores commands it does not understand", () => {
    expect(parseShellChanges("echo rm src/a.ts")).toEqual([]);
    expect(parseShellChanges("git status && ls")).toEqual([]);
    expect(parseShellChanges("mv only-one")).toEqual([]);
  });

  it("keeps quoted, escaped and wrapped commands", () => {
    expect(
      parseShellChanges('rm "src/a.ts"; sudo rm src/b.ts\nFOO=1 rm src/c.ts || git rm -- -d'),
    ).toEqual([
      { path: "src/a.ts", kind: "deleted" },
      { path: "src/b.ts", kind: "deleted" },
      { path: "src/c.ts", kind: "deleted" },
      { path: "-d", kind: "deleted" },
    ]);
    expect(parseShellChanges("rm path\\ with\\ space | true")).toEqual([
      { path: "path with space", kind: "deleted" },
    ]);
    expect(parseShellChanges("mv src/a.ts .")).toEqual([
      { path: "a.ts", kind: "renamed", from: "src/a.ts" },
    ]);
  });
});

describe("parseShellChanges bypasses", () => {
  // Each of these deleted or moved a guarded file while the PreToolUse hook saw nothing.
  it("reads git mv, full command paths, subshells, cd, mv -t and sh -c", () => {
    expect(parseShellChanges("git mv src/core/a.ts x.ts")).toEqual([
      { path: "x.ts", kind: "renamed", from: "src/core/a.ts" },
    ]);
    expect(parseShellChanges("/bin/rm src/a.ts; (rm src/b.ts); unlink src/c.ts")).toEqual([
      { path: "src/a.ts", kind: "deleted" },
      { path: "src/b.ts", kind: "deleted" },
      { path: "src/c.ts", kind: "deleted" },
    ]);
    expect(parseShellChanges("cd src/core && rm a.ts && cd - && rm b.ts")).toEqual([
      { path: "src/core/a.ts", kind: "deleted" },
      { path: "b.ts", kind: "deleted" },
    ]);
    expect(parseShellChanges("mv -t /tmp src/a.ts src/b.ts")).toEqual([
      { path: "/tmp/a.ts", kind: "renamed", from: "src/a.ts" },
      { path: "/tmp/b.ts", kind: "renamed", from: "src/b.ts" },
    ]);
    expect(parseShellChanges(`bash -c "git -C src rm core/a.ts"`)).toEqual([
      { path: "src/core/a.ts", kind: "deleted" },
    ]);
  });

  // Review WP10: each of these deleted a guarded file while the hook saw nothing.
  it("reads wrappers with flags, combined shell flags, background jobs and if or for bodies", () => {
    const gone = [{ path: "src/a.ts", kind: "deleted" }];
    for (const line of [
      "time rm src/a.ts",
      "nice -n 5 rm src/a.ts",
      "nohup rm src/a.ts",
      "env -i rm src/a.ts",
      "env -u HOME FOO=1 rm src/a.ts",
      "sudo -u root rm src/a.ts",
      `bash -lc "rm src/a.ts"`,
      `bash -ec 'rm src/a.ts'`,
      "true & rm src/a.ts",
      "if true; then rm src/a.ts; fi",
      "for f in x; do rm src/a.ts; done",
    ]) {
      expect(parseShellChanges(line), line).toEqual(gone);
    }
    // `&` inside a redirection is not a separator.
    expect(parseShellChanges("rm src/a.ts 2>&1 > /dev/null &>log")).toEqual(gone);
  });

  it("leaves files that stay on disk alone", () => {
    expect(parseShellChanges("git rm --cached -r src")).toEqual([]);
  });

  it("spots commands that skip the git hooks", () => {
    expect(hookBypass("git commit -m x --no-verify")).toMatch(/--no-verify/);
    expect(hookBypass("git add . && git commit -nm wip")).toMatch(/--no-verify/);
    expect(hookBypass("git push --no-verify origin main")).toMatch(/--no-verify/);
    expect(hookBypass("git -c core.hooksPath=/dev/null commit -m x")).toMatch(/hooksPath/);
    expect(hookBypass(`sh -c "git commit --no-verify"`)).toMatch(/--no-verify/);
    // `-m` takes the rest of its word as the message, and `git push -n` is a dry run.
    expect(hookBypass("git commit -mnew")).toBeUndefined();
    expect(hookBypass("git commit -m 'fix -n flag'")).toBeUndefined();
    expect(hookBypass("git push -n")).toBeUndefined();
  });

  // Review WP10: git takes any unique prefix of a long option, and the hooks can be turned off
  // through config, the environment or by removing them. The guard never runs after any of these.
  it("spots hook skips through option prefixes, config, the environment and the hook files", () => {
    for (const line of [
      "git commit --no-verif -m x",
      "git commit --no-veri -m x",
      "git push --no-verif",
      "git config core.hooksPath /dev/null",
      "git --config-env=core.hooksPath=HP commit -m x",
      "git --config-env core.hooksPath=HP push",
      "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit",
      "rm .git/hooks/pre-commit",
      "chmod -x .git/hooks/pre-commit",
      "mv .git/sati/hooks/pre-commit /tmp/x",
    ]) {
      expect(hookBypass(line), line).toBeDefined();
    }
    // `--no-ver` could be --no-verbose too, so git refuses it; reading the setting is fine.
    expect(hookBypass("git commit --no-verbose -m x")).toBeUndefined();
    expect(hookBypass("git config --get core.hooksPath")).toBeUndefined();
    expect(hookBypass("cat .git/hooks/pre-commit")).toBeUndefined();
  });
});
