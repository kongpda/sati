import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sati, satiJson, tempRepo } from "./helpers.js";

interface Change {
  path: string;
  action: string;
}

// `rules sync` is how a template change reaches every repo, so it must refresh sati's block
// without touching the user's text, and report nothing to do when nothing changed.
describe("sati rules sync", () => {
  it("rewrites an old block in place and keeps the user's text", async () => {
    const dir = await tempRepo({ init: true });
    const file = join(dir, "AGENTS.md");
    writeFileSync(
      file,
      "# Ours\n\n<!-- sati:start v0 -->\nold rules\n<!-- sati:end -->\n\nMore of ours.\n",
    );
    const r = satiJson<Change[]>(dir, "rules", "sync", "--tools", "codex");
    expect(r.code).toBe(0);
    expect(r.data).toEqual([
      { path: "AGENTS.md", action: "update" },
      { path: ".codex/config.toml", action: "create" },
    ]);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^# Ours\n\n<!-- sati:start v1 -->/);
    expect(text).not.toContain("old rules");
    expect(text).toMatch(/<!-- sati:end -->\n\nMore of ours\.\n$/);
    expect(sati(dir, "rules", "sync", "--tools", "codex").stdout).toContain(
      "Everything is up to date.",
    );
  });

  it("in stealth mode refreshes sati's own ignored files and keeps git status clean", async () => {
    const dir = await tempRepo();
    expect(sati(dir, "init", "--yes", "--mode", "stealth", "--tools", "claude-code").code).toBe(0);
    const local = join(dir, "CLAUDE.local.md");
    writeFileSync(local, readFileSync(local, "utf8").replace("required", "stale"));
    const r = satiJson<Change[]>(dir, "rules", "sync", "--tools", "claude-code");
    expect(r.data).toContainEqual({ path: "CLAUDE.local.md", action: "update" });
    expect(readFileSync(local, "utf8")).toContain("(required)");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });

  // The flag is given once. `sati upgrade` and later syncs run without it and must keep the
  // command form; --no-cli-only is the way back.
  it("--cli-only writes the rules as commands and later runs keep them", async () => {
    const dir = await tempRepo({ init: true });
    const rules = () => readFileSync(join(dir, "AGENTS.md"), "utf8");
    const first = satiJson<Change[]>(dir, "rules", "sync", "--tools", "codex", "--cli-only");
    expect(first.data).toEqual([{ path: "AGENTS.md", action: "create" }]);
    expect(rules()).toContain("There are no MCP tools here");
    expect(rules()).toContain("`sati task claim`");
    expect(sati(dir, "rules", "sync", "--tools", "codex").stdout).toContain(
      "Everything is up to date.",
    );
    const back = satiJson<Change[]>(dir, "rules", "sync", "--tools", "codex", "--no-cli-only");
    expect(back.data).toEqual([
      { path: "AGENTS.md", action: "update" },
      { path: ".codex/config.toml", action: "create" },
    ]);
    expect(rules()).toContain("`task_claim` a ready task");
  });
});
