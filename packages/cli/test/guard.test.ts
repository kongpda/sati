import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateDb, SqliteStore } from "@brain/store-sqlite";
import { describe, expect, it } from "vitest";
import { bin, brain, brainJson, run, tempRepo } from "./helpers.js";

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
  const feature = brainJson<Rec>(dir, ...args, ...(protect ? ["--protected"] : [])).data;
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
describe("brain guard --staged", () => {
  it("blocks a staged deletion of a protected feature until a decision lists it", async () => {
    const { dir, feature } = await billingRepo();
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    const blocked = brain(dir, "guard", "--staged");
    expect(blocked.code).toBe(10);
    expect(blocked.stdout).toContain("blocked: This deletes src/billing/invoice.ts");
    expect(blocked.stdout).toContain("BRAIN_GUARD=off");

    brain(
      dir,
      "decision",
      "record",
      "Drop invoices",
      "--decision",
      "Moved out.",
      "--features",
      feature.id,
    );
    const allowed = brainJson<{ verdict: string }>(dir, "guard", "--staged");
    expect(allowed).toMatchObject({ code: 0, data: { verdict: "warn" } });
  });

  it("blocks gutting a protected feature, warns on a small edit, passes unrelated files", async () => {
    const { dir } = await billingRepo();
    writeFileSync(join(dir, "README.md"), "changed\n");
    git(dir, "add", "README.md");
    expect(brain(dir, "guard", "--staged")).toMatchObject({ code: 0, stdout: "Guard: ok.\n" });

    // 9 of the 20 lines of the feature's changed files: under half.
    writeFileSync(join(dir, "src/billing/invoice.ts"), "line 0\n");
    writeFileSync(join(dir, "src/billing/tax.ts"), lines(10).concat("more\n"));
    git(dir, "add", ".");
    expect(brain(dir, "guard", "--staged").code).toBe(0);

    writeFileSync(join(dir, "src/billing/tax.ts"), "");
    git(dir, "add", ".");
    const r = brain(dir, "guard", "--staged");
    expect(r.code).toBe(10);
    expect(r.stdout).toContain("removes 95% of the changed lines");
  });

  it("BRAIN_GUARD=off lets a blocked commit through and logs the override", async () => {
    const { dir, feature } = await billingRepo();
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    const r = run(dir, ["guard", "--staged"], { BRAIN_GUARD: "off" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("let through by BRAIN_GUARD=off");
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
    const r = brain(dir, "guard", "--staged");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      'warning: src/billing/invoice.ts belongs to shipped feature "Billing"',
    );
    expect(await guardRows(dir)).toHaveLength(1);
  });
});

describe("brain guard --paths and --hook", () => {
  it("--paths blocks a file in another agent's exclusive lock", async () => {
    const dir = await tempRepo({ init: true });
    run(dir, ["lock", "acquire", "src/auth/**"], { BRAIN_ACTOR: "other" });
    const r = brain(dir, "guard", "--paths", "src/auth/login.ts,README.md");
    expect(r.code).toBe(10);
    expect(r.stdout).toContain("src/auth/login.ts is inside a exclusive lock held by other");
    expect(brain(dir, "guard").code).toBe(2);
  });

  // Claude Code reads exit 2 as "block the tool call" and shows stderr to the agent.
  it("--hook blocks an Edit inside a lock with exit 2, and passes warnings as context", async () => {
    const { dir } = await billingRepo(false);
    run(dir, ["lock", "acquire", "src/auth"], { BRAIN_ACTOR: "other" });
    const hook = (file_path: string) =>
      execFileSync(process.execPath, [bin, "guard", "--hook"], {
        cwd: dir,
        env: { ...process.env, BRAIN_ACTOR: "tester" },
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
});

describe("pre-commit hook", () => {
  it("brain init installs it, and it stops a commit that deletes a protected feature", async () => {
    const dir = await tempRepo();
    const init = brainJson<{ files: { path: string; action: string }[] }>(
      dir,
      "init",
      "--yes",
      "--tools",
      "",
    );
    expect(init.data.files).toContainEqual({ path: ".git/hooks/pre-commit", action: "create" });
    const hookFile = join(dir, ".git/hooks/pre-commit");
    expect(statSync(hookFile).mode & 0o111).not.toBe(0);

    // The hook runs `brain` from PATH, so put a shim for the built CLI there.
    const shims = join(dir, ".git/shims");
    mkdirSync(shims);
    writeFileSync(join(shims, "brain"), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
    chmodSync(join(shims, "brain"), 0o755);
    const env = { ...process.env, PATH: `${shims}:${process.env.PATH}`, BRAIN_ACTOR: "tester" };

    mkdirSync(join(dir, "src/billing"), { recursive: true });
    writeFileSync(join(dir, "src/billing/a.ts"), lines(3));
    git(dir, "add", ".");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a"], {
      cwd: dir,
      env,
    });
    brain(
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
    expect(() =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "rm"], {
        cwd: dir,
        env,
        stdio: "pipe",
      }),
    ).toThrow(/protected feature/);
  });

  it("never overwrites an existing pre-commit hook", async () => {
    const dir = await tempRepo();
    const hookFile = join(dir, ".git/hooks/pre-commit");
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(hookFile, "#!/bin/sh\nnpm test\n");
    const init = brainJson<{ files: { path: string; action: string }[] }>(
      dir,
      "init",
      "--yes",
      "--tools",
      "",
    );
    expect(init.data.files).toContainEqual({ path: ".git/hooks/pre-commit", action: "skip" });
    expect(readFileSync(hookFile, "utf8")).toBe("#!/bin/sh\nnpm test\n");
  });
});
