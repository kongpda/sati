import { execFileSync } from "node:child_process";
import {
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
import { describe, expect, it } from "vitest";
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

interface Init {
  project: { id: string; slug: string; mode: string };
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
      { path: join(".sati", "sati.config.json"), action: "create" },
      { path: "AGENTS.md", action: "create" },
      { path: "CLAUDE.md", action: "update" },
      { path: ".mcp.json", action: "create" },
      { path: ".claude/settings.json", action: "create" },
      { path: ".claude/skills/sati/SKILL.md", action: "create" },
      { path: ".gitattributes", action: "create" },
      ...HOOKS.map((h) => ({ path: join(".git", "sati", "hooks", h), action: "create" })),
      ...HOOKS.map((h) => ({ path: join(".git", "hooks", h), action: "create" })),
      { path: join(".git", "config"), action: "create" },
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
    expect(config).toEqual({ version: 1, projectId: r.data.project.id, mode: "git" });
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
      { path: join(".git", "sati", "hooks", "pre-commit"), action: "create" },
      { path: join(".git", "sati", "hooks", "pre-push"), action: "create" },
      { path: join(".git", "hooks", "pre-commit"), action: "create" },
      { path: join(".git", "hooks", "pre-push"), action: "create" },
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

  it("stealth mode with no agent tools writes nothing into the working tree", async () => {
    const dir = await tempRepo();
    const r = satiJson<Init>(dir, "init", "--yes", "--mode", "stealth");
    expect(r.code).toBe(0);
    // Guard hooks only, both inside .git. Stealth commits nothing.
    expect(r.data.files).toEqual([
      { path: join(".git", "sati", "hooks", "pre-commit"), action: "create" },
      { path: join(".git", "sati", "hooks", "pre-push"), action: "create" },
      { path: join(".git", "hooks", "pre-commit"), action: "create" },
      { path: join(".git", "hooks", "pre-push"), action: "create" },
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
    expect(run(dir, ["task", "list", "--json"], { HOME: home }).code).toBe(0);
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
    expect(r.data.files).toContainEqual({ path: join(".git", "config"), action: "update" });
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
