import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

interface Init {
  project: { id: string; slug: string; mode: string; settings?: Record<string, unknown> };
  db: string;
  tools: string[];
  files: { path: string; action: string }[];
}
interface Err {
  error: { code: string; hint: string | null; details: Record<string, unknown> | null };
}

const HOOKS = ["pre-commit", "post-merge", "post-checkout", "post-rewrite", "pre-push"];

const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), "sati-init-")));

// `sati init` decides where the memory lives and what gets committed, so these tests pin
// both the files it writes and the files it must not write.
describe("sati init", () => {
  it("git mode keeps the DB inside .git and writes the config and agent files", async () => {
    const dir = await tempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# rules\n");
    const r = satiJson<Init>(dir, "init", "--yes");
    expect(r.code).toBe(0);
    expect(r.data.project.mode).toBe("git");
    expect(r.data.db).toBe(join(dir, ".git", "sati", "sati.db"));
    expect(r.data.files).toEqual([
      { path: ".sati/sati.config.json", action: "create" },
      { path: "AGENTS.md", action: "create" },
      { path: "CLAUDE.md", action: "update" },
      { path: ".mcp.json", action: "create" },
      { path: ".claude/settings.json", action: "create" },
      { path: ".claude/skills/sati/SKILL.md", action: "create" },
      { path: ".gitattributes", action: "create" },
      ...HOOKS.map((h) => ({ path: `.git/sati/hooks/${h}`, action: "create" })),
      ...HOOKS.map((h) => ({ path: `.git/hooks/${h}`, action: "create" })),
      { path: ".git/config", action: "create" },
    ]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# rules\n\n@AGENTS.md\n");
    // PLAN: the merge driver is registered through .gitattributes and local git config.
    // PLAN: linguist-generated collapses the snapshot in PR diffs.
    expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toBe(
      ".sati/**/*.json merge=sati linguist-generated\n",
    );
    const driver = execFileSync("git", ["config", "--get", "merge.sati.driver"], {
      cwd: dir,
      encoding: "utf8",
    });
    // PLAN Security: the driver starts sati by the absolute path recorded at init, not PATH.
    expect(driver).toBe(`'${bin}' merge-driver %O %A %B\n`);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- sati:start v1 -->");
    expect(r.data.tools).toContain("claude-code");
    const config = JSON.parse(readFileSync(join(dir, ".sati", "sati.config.json"), "utf8"));
    // The committed id must match the DB row, or a fresh clone would start a second project.
    expect(config).toEqual({ version: 1, projectId: r.data.project.id, mode: "git", kind: "code" });
    expect(satiJson(dir, "task", "create", "x").code).toBe(0);
  });

  // Stealth is for repos where the team has not adopted sati: `git status` must stay clean.
  it("stealth mode writes only git-ignored files, leaving git status clean", async () => {
    const dir = await tempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# shared\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    const r = satiJson<Init>(dir, "init", "--yes", "--mode", "stealth", "--tools", "claude-code");
    expect(r.code).toBe(0);
    expect(r.data.files).toEqual([
      { path: "CLAUDE.local.md", action: "create" },
      { path: ".mcp.json", action: "create" },
      { path: ".claude/settings.local.json", action: "create" },
      { path: ".claude/skills/sati/SKILL.md", action: "create" },
      { path: ".git/sati/hooks/pre-commit", action: "create" },
      { path: ".git/sati/hooks/pre-push", action: "create" },
      { path: ".git/hooks/pre-commit", action: "create" },
      { path: ".git/hooks/pre-push", action: "create" },
    ]);
    expect(readFileSync(join(dir, "CLAUDE.local.md"), "utf8")).toContain("sati:start v1");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# shared\n");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status).toBe("A  CLAUDE.md\n");
  });

  it("rejects an unknown --tools name with a usage error", async () => {
    const dir = await tempRepo();
    expect(satiJson(dir, "init", "--yes", "--tools", "vim").code).toBe(2);
  });

  // The MCP config and hooks start `sati` by name; without it on PATH they fail silently,
  // so init must say so (on stderr, keeping --json output clean).
  it("warns when sati is not on PATH, and stays quiet when it is", async () => {
    const base = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    const dir = await tempRepo();
    const missing = run(dir, ["init", "--yes", "--tools", "claude-code"], { PATH: base });
    expect(missing.code).toBe(0);
    expect(missing.stderr).toContain("warning: `sati` is not on PATH");

    const binDir = realpathSync.native(mkdtempSync(join(tmpdir(), "sati-bin-")));
    // npm installs a `sati.cmd` shim on Windows and a symlink elsewhere.
    if (process.platform === "win32") writeFileSync(join(binDir, "sati.cmd"), "@echo off\r\n");
    else symlinkSync(bin, join(binDir, "sati"));
    const other = await tempRepo();
    const found = run(other, ["init", "--yes", "--tools", "claude-code"], {
      PATH: `${binDir}${delimiter}${base}`,
    });
    expect(found.code).toBe(0);
    expect(found.stderr).toBe("");
  });

  // A project install (`npm install -D`, then `npx sati init`) must not depend on PATH: every
  // teammate gets the same version from the lockfile, and nothing global is needed.
  it("points agent configs and git hooks at node_modules/.bin for a project install", async () => {
    const dir = await tempRepo();
    const pkg = join(dir, "node_modules", "@kongpda", "sati", "dist");
    mkdirSync(pkg, { recursive: true });
    const entry = join(pkg, "index.mjs");
    writeFileSync(
      entry,
      `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(bin).href)};\n`,
    );
    chmodSync(entry, 0o755);
    mkdirSync(join(dir, "node_modules", ".bin"));
    symlinkSync(entry, join(dir, "node_modules", ".bin", "sati"));
    const base = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
    const r = spawnSync(
      process.execPath,
      [entry, "init", "--yes", "--tools", "claude-code,codex"],
      { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: base, SATI_ACTOR: "tester" } },
    );
    expect(r.status).toBe(0);
    // No PATH warning: the configs no longer need `sati` on PATH.
    expect(r.stderr).toBe("");
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.sati).toEqual({
      command: "node_modules/.bin/sati",
      args: ["mcp"],
    });
    expect(readFileSync(join(dir, ".codex", "config.toml"), "utf8")).toContain(
      'command = "node_modules/.bin/sati"',
    );
    const settings = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(settings).toContain('"\\"$CLAUDE_PROJECT_DIR\\"/node_modules/.bin/sati guard --hook"');
    expect(settings).not.toMatch(/"sati /);
    // The hooks record the .bin link, which survives a package upgrade, not the versioned file.
    const runner = readFileSync(join(dir, ".git", "sati", "hooks", "pre-commit"), "utf8");
    expect(runner).toContain(`'${join(dir, "node_modules", ".bin", "sati")}'`);
    expect(runner).not.toContain(entry);
  });

  // Git hooks live in each clone's .git, so a teammate's fresh clone has none until they run
  // init. doctor must say so, with the fix, instead of reporting the hooks as fine.
  it("doctor flags a clone without git hooks and passes after init --upgrade", async () => {
    const dir = await tempRepo({ init: true });
    type Doctor = { checks: { name: string; ok: boolean; detail: string }[] };
    const hooks = () => satiJson<Doctor>(dir, "doctor").data.checks.find((c) => c.name === "hooks");
    expect(hooks()).toMatchObject({ ok: false, detail: expect.stringContaining("init --upgrade") });
    expect(sati(dir, "init", "--upgrade", "--yes").code).toBe(0);
    expect(hooks()?.ok).toBe(true);
  });

  it("stealth mode with no agent tools writes nothing into the working tree", async () => {
    const dir = await tempRepo();
    const r = satiJson<Init>(dir, "init", "--yes", "--mode", "stealth");
    expect(r.code).toBe(0);
    // Guard hooks only, both inside .git. Stealth commits nothing.
    expect(r.data.files).toEqual([
      { path: ".git/sati/hooks/pre-commit", action: "create" },
      { path: ".git/sati/hooks/pre-push", action: "create" },
      { path: ".git/hooks/pre-commit", action: "create" },
      { path: ".git/hooks/pre-push", action: "create" },
    ]);
    expect(existsSync(join(dir, ".sati"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
    expect(satiJson(dir, "task", "list").code).toBe(0);
  });

  it("standalone mode keeps the DB under ~/.sati, outside the folder", () => {
    const dir = tempDir();
    const home = tempDir();
    const r = run(dir, ["init", "--yes", "--json"], { HOME: home });
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout) as Init;
    expect(data.db).toBe(join(home, ".sati", "projects", `${data.project.id}.db`));
    expect(existsSync(data.db)).toBe(true);
    const list = run(dir, ["task", "list", "--json"], { HOME: home });
    expect(list.code, list.stderr).toBe(0);
  });

  // Trial: outside git a card never said its file changed, so a fresh agent gave old answers.
  it("standalone mode marks a card stale when its file changes, without opening it", () => {
    const dir = tempDir();
    const home = tempDir();
    const env = { HOME: home };
    expect(run(dir, ["init", "--yes", "--kind", "general", "--tools", ""], env).code).toBe(0);
    mkdirSync(join(dir, "venue"));
    writeFileSync(join(dir, "venue", "quote.pdf"), "total 2,870");
    writeFileSync(join(dir, "budget.xlsx"), "7,500");
    const put = (path: string) =>
      run(dir, ["card", "put", path, "--summary", "read", "--json"], env).code;
    expect(put("venue")).toBe(0);
    expect(put("budget.xlsx")).toBe(0);
    const stale = () =>
      Object.fromEntries(
        (
          JSON.parse(run(dir, ["card", "get", "--json"], env).stdout) as {
            path: string;
            stale: boolean | null;
          }[]
        ).map((c) => [c.path, c.stale]),
      );
    expect(stale()).toEqual({ venue: false, "budget.xlsx": false });
    writeFileSync(join(dir, "venue", "quote.pdf"), "total 3,070 (revised)");
    expect(stale()).toEqual({ venue: true, "budget.xlsx": false });
    // Saving the card again after re-reading clears it.
    expect(put("venue")).toBe(0);
    expect(stale()).toEqual({ venue: false, "budget.xlsx": false });
  });

  it("--kind general sets up a project without feature, lock or guard rules", () => {
    const dir = tempDir();
    const home = tempDir();
    const r = run(dir, ["init", "--yes", "--kind", "general", "--tools", "", "--json"], {
      HOME: home,
    });
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as Init).project.settings).toMatchObject({ kind: "general" });
    const rules = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(rules).toContain("plans, todos, notes and decisions");
    expect(rules).not.toMatch(/feature_check|lock_acquire|--no-verify/u);
    const bad = run(dir, ["init", "--yes", "--kind", "office", "--json"], { HOME: tempDir() });
    expect(bad.code).toBe(2);
  });

  it("reuses the project id from a committed config, as in a fresh clone", async () => {
    const dir = await tempRepo();
    const projectId = "prj_01M6G33B1G2RYG4BE041CCNFNK";
    mkdirSync(join(dir, ".sati"));
    writeFileSync(
      join(dir, ".sati", "sati.config.json"),
      JSON.stringify({ version: 1, projectId, mode: "git" }),
    );
    const r = satiJson<Init>(dir, "init", "--yes");
    expect(r.data.project.id).toBe(projectId);
    expect(r.data.files[0]?.action).toBe("keep");
  });

  // The project row is not in the snapshot, so the kind travels in the committed config.
  it("takes a general kind from the committed config, and follows a later switch", async () => {
    const dir = await tempRepo();
    const projectId = "prj_01M6G33B1G2RYG4BE041CCNFNM";
    const config = join(dir, ".sati", "sati.config.json");
    mkdirSync(join(dir, ".sati"));
    writeFileSync(config, JSON.stringify({ version: 1, projectId, mode: "git", kind: "general" }));
    expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
    expect(satiJson<{ kind: string }>(dir, "settings").data.kind).toBe("general");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).not.toContain("feature_check");
    // A config from before kinds existed says nothing, so an import leaves the project alone.
    writeFileSync(config, JSON.stringify({ version: 1, projectId, mode: "git" }));
    expect(sati(dir, "sync", "import").code).toBe(0);
    expect(satiJson<{ kind: string }>(dir, "settings").data.kind).toBe("general");
    // A teammate switches to code and commits the config; the next import follows it.
    writeFileSync(config, JSON.stringify({ version: 1, projectId, mode: "git", kind: "code" }));
    expect(sati(dir, "import").code).toBe(0);
    expect(satiJson<{ kind: string }>(dir, "settings").data.kind).toBe("code");
    // And `settings --kind` writes the config for everyone else.
    sati(dir, "settings", "--kind", "general");
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({ kind: "general" });
  });

  // An explicit --kind in a clone wins, and is recorded so the git hooks do not switch it back.
  it("records an explicit --kind over the committed one", async () => {
    const dir = await tempRepo();
    const config = join(dir, ".sati", "sati.config.json");
    mkdirSync(join(dir, ".sati"));
    const projectId = "prj_01M6G33B1G2RYG4BE041CCNFNM";
    writeFileSync(config, JSON.stringify({ version: 1, projectId, mode: "git", kind: "general" }));
    expect(sati(dir, "init", "--yes", "--tools", "", "--kind", "code").code).toBe(0);
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject({ kind: "code" });
    expect(sati(dir, "sync", "import").code).toBe(0);
    expect(satiJson<{ kind: string }>(dir, "settings").data.kind).toBe("code");
  });

  // Why: a teammate who clones and runs init must see the shared tasks, not an empty project.
  it("loads the committed .sati/ snapshot when init runs in a fresh clone", async () => {
    const origin = await tempRepo();
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });
    git(origin, "commit", "-q", "--allow-empty", "-m", "root");
    expect(sati(origin, "init", "--yes", "--tools", "").code).toBe(0);
    expect(sati(origin, "task", "create", "Shared task").code).toBe(0);
    git(origin, "add", "-A");
    git(origin, "commit", "-q", "-m", "snapshot");
    const clone = join(mkdtempSync(join(tmpdir(), "sati-clone-")), "b");
    git(origin, "clone", "-q", origin, clone);

    const r = satiJson<Init & { imported: number }>(clone, "init", "--yes", "--tools", "");
    expect(r.code).toBe(0);
    expect(r.data.imported).toBe(1);
    const list = satiJson<{ title: string }[]>(clone, "task", "list");
    expect(list.data.map((t) => t.title)).toEqual(["Shared task"]);
  });

  it("refuses a second init with CONFLICT (exit 4) instead of creating a new project", async () => {
    const dir = await tempRepo();
    expect(sati(dir, "init", "--yes").code).toBe(0);
    const r = satiJson<Err>(dir, "init", "--yes");
    expect(r.code).toBe(4);
    expect(r.data.error.code).toBe("CONFLICT");
    expect(r.data.error.hint).toContain("sati init --upgrade");
  });

  // PLAN: an initialized project gets newer hooks, driver and .gitattributes without a re-init.
  it("--upgrade rewrites only the managed git files of an initialized project", async () => {
    const dir = await tempRepo();
    expect(satiJson<Err>(dir, "init", "--upgrade", "--yes").code).toBe(6);
    expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
    // What an older sati wrote: the bare attribute line and a driver found on PATH.
    writeFileSync(join(dir, ".gitattributes"), "*.png binary\n.sati/**/*.json merge=sati\n");
    execFileSync("git", ["config", "merge.sati.driver", "sati merge-driver %O %A %B"], {
      cwd: dir,
    });
    writeFileSync(join(dir, "AGENTS.md"), "mine\n");

    const r = satiJson<{ upgraded: { slug: string }; files: Init["files"] }>(
      dir,
      "init",
      "--upgrade",
      "--yes",
    );
    expect(r.code).toBe(0);
    expect(r.data.files).toContainEqual({ path: ".gitattributes", action: "update" });
    expect(r.data.files).toContainEqual({ path: ".git/config", action: "update" });
    expect(readFileSync(join(dir, ".gitattributes"), "utf8")).toBe(
      "*.png binary\n.sati/**/*.json merge=sati linguist-generated\n",
    );
    // Agent files are `sati rules sync`'s job, not upgrade's.
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe("mine\n");
    const again = satiJson<{ files: Init["files"] }>(dir, "init", "--upgrade", "--yes");
    expect(again.data.files.every((f) => f.action === "keep")).toBe(true);
  });

  it("rejects modes that do not fit the folder", async () => {
    expect(satiJson<Err>(await tempRepo(), "init", "--yes", "--mode", "standalone").code).toBe(5);
    expect(satiJson<Err>(tempDir(), "init", "--yes", "--mode", "git").code).toBe(5);
    expect(satiJson<Err>(await tempRepo(), "init", "--yes", "--mode", "cloud").code).toBe(2);
  });

  it("without a terminal it writes nothing unless --yes is given, and shows the preview", async () => {
    const dir = await tempRepo();
    const r = satiJson<Err>(dir, "init");
    expect(r.code).toBe(2);
    expect(r.data.error.details).toMatchObject({ preview: { mode: "git" } });
    expect(existsSync(join(dir, ".sati"))).toBe(false);
    expect(existsSync(join(dir, ".git", "sati", "sati.db"))).toBe(false);
  });
});
