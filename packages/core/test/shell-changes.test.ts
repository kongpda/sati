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

  // A false alarm here blocks an honest commit, and a miss lets the guard be skipped.
  it("reads the word after a value flag as that value, not as -n", () => {
    for (const line of [
      "git commit -m -n",
      "git commit --message -n",
      "git commit -F -n",
      "git commit -am -n",
      "git commit --author -n -m x",
      "git commit -m x -- -n",
    ]) {
      expect(hookBypass(line), line).toBeUndefined();
    }
    // `-S` and `-u` take a value only inside the same word, so `-n` after them is still a flag.
    expect(hookBypass("git commit -S -n -m x")).toMatch(/--no-verify/);
    expect(hookBypass("git commit -m x -n")).toMatch(/--no-verify/);
    expect(hookBypass("git commit --message=x -n")).toMatch(/--no-verify/);
  });

  // husky runs our block from `.husky/pre-commit`; removing that file turns the guard off.
  it("spots the removal of a husky hook file, and allows husky setup", () => {
    expect(hookBypass("rm .husky/pre-commit")).toMatch(/husky/);
    expect(hookBypass("mv .husky/pre-commit /tmp/x")).toMatch(/husky/);
    expect(hookBypass("chmod +x .husky/pre-commit")).toBeUndefined();
    expect(hookBypass("rm -rf .husky/_")).toBeUndefined();
    expect(hookBypass("mv /tmp/new .husky/pre-commit")).toBeUndefined();
  });

  // Review 0.1: inside double quotes `\"` is a literal quote. Reading it as the closing quote
  // swallows the rest of the line into one string, so a delete after it was never checked.
  it("an escaped quote inside a double-quoted string does not hide a later rm", () => {
    expect(parseShellChanges('echo "a \\"b\\"" && rm src/x.ts')).toEqual([
      { path: "src/x.ts", kind: "deleted" },
    ]);
    expect(parseShellChanges('echo "\\"" ; rm src/a.ts')).toEqual([
      { path: "src/a.ts", kind: "deleted" },
    ]);
    expect(hookBypass('git commit -m "say \\"hi\\"" && git push --no-verify')).toBe(
      "`git push --no-verify` skips the git hooks.",
    );
    // A backslash is literal inside single quotes, so `'a\'` closes there and `&&` still splits.
    expect(parseShellChanges("echo 'a\\' && rm src/x.ts")).toEqual([
      { path: "src/x.ts", kind: "deleted" },
    ]);
  });

  // The guard checks the path a record points at; a wrong new path hides the move from it.
  it("drops a closing slash from the moved folder's name", () => {
    expect(parseShellChanges("mv src/a/ dest/")).toEqual(parseShellChanges("mv src/a dest/"));
  });
});
