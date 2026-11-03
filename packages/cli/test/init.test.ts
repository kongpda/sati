import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brain, brainJson, run, tempRepo } from "./helpers.js";

interface Init {
  project: { id: string; slug: string; mode: string };
  db: string;
  tools: string[];
  files: { path: string; action: string }[];
}
interface Err {
  error: { code: string; hint: string | null; details: Record<string, unknown> | null };
}

const tempDir = () => realpathSync(mkdtempSync(join(tmpdir(), "brain-init-")));

// `brain init` decides where the memory lives and what gets committed, so these tests pin
// both the files it writes and the files it must not write.
describe("brain init", () => {
  it("git mode keeps the DB inside .git and writes the config and agent files", async () => {
    const dir = await tempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# rules\n");
    const r = brainJson<Init>(dir, "init", "--yes");
    expect(r.code).toBe(0);
    expect(r.data.project.mode).toBe("git");
    expect(r.data.db).toBe(join(dir, ".git", "brain", "brain.db"));
    expect(r.data.files).toEqual([
      { path: join(".brain", "brain.config.json"), action: "create" },
      { path: "AGENTS.md", action: "create" },
      { path: "CLAUDE.md", action: "update" },
      { path: ".mcp.json", action: "create" },
      { path: ".claude/settings.json", action: "create" },
      { path: ".claude/skills/brain/SKILL.md", action: "create" },
    ]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# rules\n\n@AGENTS.md\n");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("<!-- brain:start v1 -->");
    expect(r.data.tools).toContain("claude-code");
    const config = JSON.parse(readFileSync(join(dir, ".brain", "brain.config.json"), "utf8"));
    // The committed id must match the DB row, or a fresh clone would start a second project.
    expect(config).toEqual({ version: 1, projectId: r.data.project.id, mode: "git" });
    expect(brainJson(dir, "task", "create", "x").code).toBe(0);
  });

  // Stealth is for repos where the team has not adopted brain: `git status` must stay clean.
  it("stealth mode writes only git-ignored files, leaving git status clean", async () => {
    const dir = await tempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# shared\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    const r = brainJson<Init>(dir, "init", "--yes", "--mode", "stealth", "--tools", "claude-code");
    expect(r.code).toBe(0);
    expect(r.data.files).toEqual([
      { path: "CLAUDE.local.md", action: "create" },
      { path: ".mcp.json", action: "create" },
      { path: ".claude/settings.local.json", action: "create" },
      { path: ".claude/skills/brain/SKILL.md", action: "create" },
    ]);
    expect(readFileSync(join(dir, "CLAUDE.local.md"), "utf8")).toContain("brain:start v1");
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# shared\n");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status).toBe("A  CLAUDE.md\n");
  });

  it("rejects an unknown --tools name with a usage error", async () => {
    const dir = await tempRepo();
    expect(brainJson(dir, "init", "--yes", "--tools", "vim").code).toBe(2);
  });

  it("stealth mode with no agent tools writes nothing into the working tree", async () => {
    const dir = await tempRepo();
    const r = brainJson<Init>(dir, "init", "--yes", "--mode", "stealth");
    expect(r.code).toBe(0);
    expect(r.data.files).toEqual([]);
    expect(existsSync(join(dir, ".brain"))).toBe(false);
    expect(brainJson(dir, "task", "list").code).toBe(0);
  });

  it("standalone mode keeps the DB under ~/.brain, outside the folder", () => {
    const dir = tempDir();
    const home = tempDir();
    const r = run(dir, ["init", "--yes", "--json"], { HOME: home });
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout) as Init;
    expect(data.db).toBe(join(home, ".brain", "projects", `${data.project.id}.db`));
    expect(existsSync(data.db)).toBe(true);
    expect(run(dir, ["task", "list", "--json"], { HOME: home }).code).toBe(0);
  });

  it("reuses the project id from a committed config, as in a fresh clone", async () => {
    const dir = await tempRepo();
    const projectId = "prj_01M6G33B1G2RYG4BE041CCNFNK";
    mkdirSync(join(dir, ".brain"));
    writeFileSync(
      join(dir, ".brain", "brain.config.json"),
      JSON.stringify({ version: 1, projectId, mode: "git" }),
    );
    const r = brainJson<Init>(dir, "init", "--yes");
    expect(r.data.project.id).toBe(projectId);
    expect(r.data.files[0]?.action).toBe("keep");
  });

  it("refuses a second init with CONFLICT (exit 4) instead of creating a new project", async () => {
    const dir = await tempRepo();
    expect(brain(dir, "init", "--yes").code).toBe(0);
    const r = brainJson<Err>(dir, "init", "--yes");
    expect(r.code).toBe(4);
    expect(r.data.error.code).toBe("CONFLICT");
  });

  it("rejects modes that do not fit the folder", async () => {
    expect(brainJson<Err>(await tempRepo(), "init", "--yes", "--mode", "standalone").code).toBe(5);
    expect(brainJson<Err>(tempDir(), "init", "--yes", "--mode", "git").code).toBe(5);
    expect(brainJson<Err>(await tempRepo(), "init", "--yes", "--mode", "cloud").code).toBe(2);
  });

  it("without a terminal it writes nothing unless --yes is given, and shows the preview", async () => {
    const dir = await tempRepo();
    const r = brainJson<Err>(dir, "init");
    expect(r.code).toBe(2);
    expect(r.data.error.details).toMatchObject({ preview: { mode: "git" } });
    expect(existsSync(join(dir, ".brain"))).toBe(false);
    expect(existsSync(join(dir, ".git", "brain", "brain.db"))).toBe(false);
  });
});
