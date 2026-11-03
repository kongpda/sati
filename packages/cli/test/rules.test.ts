import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brain, brainJson, tempRepo } from "./helpers.js";

interface Change {
  path: string;
  action: string;
}

// `rules sync` is how a template change reaches every repo, so it must refresh brain's block
// without touching the user's text, and report nothing to do when nothing changed.
describe("brain rules sync", () => {
  it("rewrites an old block in place and keeps the user's text", async () => {
    const dir = await tempRepo({ init: true });
    const file = join(dir, "AGENTS.md");
    writeFileSync(
      file,
      "# Ours\n\n<!-- brain:start v0 -->\nold rules\n<!-- brain:end -->\n\nMore of ours.\n",
    );
    const r = brainJson<Change[]>(dir, "rules", "sync", "--tools", "codex");
    expect(r.code).toBe(0);
    expect(r.data).toEqual([
      { path: "AGENTS.md", action: "update" },
      { path: ".codex/config.toml", action: "create" },
    ]);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^# Ours\n\n<!-- brain:start v1 -->/);
    expect(text).not.toContain("old rules");
    expect(text).toMatch(/<!-- brain:end -->\n\nMore of ours\.\n$/);
    expect(brain(dir, "rules", "sync", "--tools", "codex").stdout).toContain(
      "Everything is up to date.",
    );
  });

  it("in stealth mode refreshes brain's own ignored files and keeps git status clean", async () => {
    const dir = await tempRepo();
    expect(brain(dir, "init", "--yes", "--mode", "stealth", "--tools", "claude-code").code).toBe(0);
    const local = join(dir, "CLAUDE.local.md");
    writeFileSync(local, readFileSync(local, "utf8").replace("required", "stale"));
    const r = brainJson<Change[]>(dir, "rules", "sync", "--tools", "claude-code");
    expect(r.data).toContainEqual({ path: "CLAUDE.local.md", action: "update" });
    expect(readFileSync(local, "utf8")).toContain("(required)");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe("");
  });
});
