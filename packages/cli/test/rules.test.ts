import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sati, satiJson, tempRepo } from "./helpers.js";

interface Change {
  path: string;
  action: string;
}

/** What `upgrade --json` did to the agent files; the hooks it also manages are not asked about. */
const agentFiles = (files: Change[]) =>
  files.filter((f) => /AGENTS\.md$|config\.toml$|\.local\.md$/u.test(f.path));

// `upgrade` is how a template change reaches every repo, so it must refresh sati's block
// without touching the user's text, and report nothing to do when nothing changed.
describe("sati upgrade (agent files)", () => {
  it("rewrites an old block in place and keeps the user's text", async () => {
    const dir = await tempRepo({ init: true });
    const file = join(dir, "AGENTS.md");
    writeFileSync(
      file,
      "# Ours\n\n<!-- sati:start v0 -->\nold rules\n<!-- sati:end -->\n\nMore of ours.\n",
    );
    const r = satiJson<{ files: Change[] }>(dir, "upgrade", "--tools", "codex");
    expect(r.code).toBe(0);
    expect(agentFiles(r.data.files)).toEqual([
      { path: "AGENTS.md", action: "update" },
      { path: ".codex/config.toml", action: "create" },
    ]);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^# Ours\n\n<!-- sati:start v1 -->/);
    expect(text).not.toContain("old rules");
    expect(text).toMatch(/<!-- sati:end -->\n\nMore of ours\.\n$/);
    expect(
      agentFiles(
        satiJson<{ files: Change[] }>(dir, "upgrade", "--tools", "codex").data.files,
      ).every((f) => f.action === "keep"),
    ).toBe(true);
  });

  it("in stealth mode refreshes sati's own ignored files and keeps git status clean", async () => {
    const dir = await tempRepo();
    expect(sati(dir, "init", "--yes", "--mode", "stealth", "--tools", "claude-code").code).toBe(0);
    const local = join(dir, "CLAUDE.local.md");
    writeFileSync(local, readFileSync(local, "utf8").replace("required", "stale"));
    const r = satiJson<{ files: Change[] }>(dir, "upgrade", "--tools", "claude-code");
    expect(r.data.files).toContainEqual({ path: "CLAUDE.local.md", action: "update" });
    expect(readFileSync(local, "utf8")).toContain("(required)");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });

  // A project for agents with no MCP client must never get an MCP config, not even for the
  // moment between `init` and a later `upgrade --cli-only`.
  it("init --cli-only sets a new project up with commands and no MCP config", async () => {
    const dir = await tempRepo();
    const r = sati(dir, "init", "--yes", "--tools", "codex,claude-code", "--cli-only");
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("There are no MCP tools here");
    expect(existsSync(join(dir, ".codex/config.toml"))).toBe(false);
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
    // The session hook stays, with a brief that does not claim MCP tools.
    const hooks = readFileSync(join(dir, ".claude/settings.json"), "utf8");
    expect(hooks).toContain("brief --format=agent");
    expect(hooks).not.toContain("--tools=mcp");
    // A plain upgrade later keeps the form.
    expect(sati(dir, "upgrade").code).toBe(0);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("There are no MCP tools here");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  // The flag is given once. `sati upgrade` and later syncs run without it and must keep the
  // command form; --no-cli-only is the way back.
  it("--cli-only writes the rules as commands and later runs keep them", async () => {
    const dir = await tempRepo({ init: true });
    const rules = () => readFileSync(join(dir, "AGENTS.md"), "utf8");
    const first = satiJson<{ files: Change[] }>(dir, "upgrade", "--tools", "codex", "--cli-only");
    expect(agentFiles(first.data.files)).toEqual([{ path: "AGENTS.md", action: "create" }]);
    expect(rules()).toContain("There are no MCP tools here");
    expect(rules()).toContain("`sati task claim`");
    expect(
      agentFiles(
        satiJson<{ files: Change[] }>(dir, "upgrade", "--tools", "codex").data.files,
      ).every((f) => f.action === "keep"),
    ).toBe(true);
    const back = satiJson<{ files: Change[] }>(dir, "upgrade", "--tools", "codex", "--no-cli-only");
    expect(agentFiles(back.data.files)).toEqual([
      { path: "AGENTS.md", action: "update" },
      { path: ".codex/config.toml", action: "create" },
    ]);
    expect(rules()).toContain("`task_claim` a ready task");
  });

  // Old scripts and docs name `rules sync`. It stays, out of help and completion.
  it("rules sync still runs for old scripts, and help does not list it", async () => {
    const dir = await tempRepo({ init: true });
    expect(sati(dir, "rules", "sync", "--tools", "codex").code).toBe(0);
    expect(sati(dir, "--help").stdout).not.toMatch(/^\s+rules\b/mu);
  });
});
