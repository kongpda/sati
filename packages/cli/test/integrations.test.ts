import { describe, expect, it } from "vitest";
import {
  type PlannedFile,
  planIntegrations,
  RULES_BLOCK,
  upsertBlock,
} from "../src/integrations.js";

const reader = (files: Record<string, string>) => (path: string) => files[path];
const byPath = (plan: PlannedFile[]) => Object.fromEntries(plan.map((f) => [f.path, f]));

// These files belong to the user. sati may only own the text between its markers
// and its own MCP entry; everything else must survive every run unchanged.
describe("agent file planning", () => {
  it("replaces only the managed block, keeping the user's text around it", () => {
    const user = "# Team rules\n\nUse tabs.\n";
    const once = upsertBlock(user);
    expect(once).toBe(`${user}\n${RULES_BLOCK}`);
    const old = once.replace("start v1", "start v0").replace("Several agents", "Old text");
    expect(upsertBlock(`${old}\nAfter.\n`)).toBe(`${once}\nAfter.\n`);
    expect(upsertBlock(once)).toBe(once);
  });

  it("keeps the block under 30 lines so it costs little context", () => {
    expect(RULES_BLOCK.trimEnd().split("\n").length).toBeLessThan(30);
  });

  it("writes AGENTS.md for everyone and only the files of the selected tools", () => {
    const plan = byPath(planIntegrations(["claude-code"], "git", reader({})));
    expect(Object.keys(plan).sort()).toEqual([
      ".claude/settings.json",
      ".claude/skills/sati/SKILL.md",
      ".mcp.json",
      "AGENTS.md",
      "CLAUDE.md",
    ]);
    expect(plan[".claude/skills/sati/SKILL.md"]?.content).toMatch(
      /^---\nname: sati\ndescription: /,
    );
    expect(plan["CLAUDE.md"]?.content).toBe("@AGENTS.md\n");
    expect(JSON.parse(plan[".mcp.json"]?.content ?? "")).toEqual({
      mcpServers: { sati: { command: "sati", args: ["mcp"] } },
    });
  });

  it("merges into existing MCP configs and leaves a user's own sati entry alone", () => {
    const mine = { mcpServers: { sati: { command: "npx", args: ["@kongpda/sati", "mcp"] } } };
    const other = { mcpServers: { db: { command: "db-mcp" } }, theme: "dark" };
    const plan = byPath(
      planIntegrations(
        ["claude-code", "cursor", "codex"],
        "git",
        reader({
          ".mcp.json": JSON.stringify(mine),
          ".cursor/mcp.json": JSON.stringify(other),
          ".codex/config.toml": 'model = "o5"\n',
        }),
      ),
    );
    expect(plan[".mcp.json"]?.action).toBe("keep");
    expect(JSON.parse(plan[".cursor/mcp.json"]?.content ?? "")).toEqual({
      mcpServers: { db: { command: "db-mcp" }, sati: { command: "sati", args: ["mcp"] } },
      theme: "dark",
    });
    expect(plan[".codex/config.toml"]?.content).toBe(
      'model = "o5"\n\n[mcp_servers.sati]\ncommand = "sati"\nargs = ["mcp"]\n',
    );
    expect(plan[".cursor/rules/sati.mdc"]?.content).toMatch(/^---\n.*\nalwaysApply: true\n---\n/);
  });

  // A merge that reindents someone's config turns one added entry into a whole-file diff.
  it("keeps the indent of an existing JSON config", () => {
    const other = { mcpServers: { db: { command: "db-mcp" } } };
    const files = { ".mcp.json": JSON.stringify(other, null, 4), ".cursor/mcp.json": "{}" };
    const plan = byPath(planIntegrations(["claude-code", "cursor"], "git", reader(files)));
    const merged = {
      mcpServers: { ...other.mcpServers, sati: { command: "sati", args: ["mcp"] } },
    };
    expect(plan[".mcp.json"]?.content).toBe(`${JSON.stringify(merged, null, 4)}\n`);
    expect(plan[".cursor/mcp.json"]?.content).toBe(
      `${JSON.stringify({ mcpServers: { sati: { command: "sati", args: ["mcp"] } } }, null, 2)}\n`,
    );
  });

  // Hooks are how the brief and nudge run without the agent remembering to; the user's own
  // hooks and settings must survive.
  it("adds the SessionStart, PreToolUse and Stop hooks to Claude Code settings, keeping the user's", () => {
    const mine = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    };
    const plan = byPath(
      planIntegrations(
        ["claude-code"],
        "git",
        reader({ ".claude/settings.json": JSON.stringify(mine) }),
      ),
    );
    const settings = JSON.parse(plan[".claude/settings.json"]?.content ?? "");
    expect(settings.permissions).toEqual({
      ...mine.permissions,
      deny: ["Bash(git commit --no-verify:*)", "Bash(git commit -n:*)"],
    });
    expect(
      settings.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0]?.command),
    ).toEqual(["say done", "sati nudge"]);
    expect(settings.hooks.SessionStart).toEqual([
      {
        matcher: "startup|clear",
        hooks: [{ type: "command", command: "sati brief --format=agent" }],
      },
      {
        matcher: "resume|compact",
        hooks: [{ type: "command", command: "sati brief --format=short" }],
      },
    ]); // The guard runs before every file edit.
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "Edit|MultiEdit|Write|NotebookEdit",
        hooks: [{ type: "command", command: "sati guard --hook" }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "sati guard --hook" }],
      },
    ]);
  });

  it("refuses to merge into a malformed hooks setting instead of crashing", () => {
    const bad = JSON.stringify({ hooks: { Stop: "sati nudge" } });
    expect(() =>
      planIntegrations(["claude-code"], "git", reader({ ".claude/settings.json": bad })),
    ).toThrow(/"hooks" setting is malformed/);
  });

  it("refuses to overwrite an MCP config it cannot parse", () => {
    expect(() =>
      planIntegrations(["claude-code"], "git", reader({ ".mcp.json": "{ nope" })),
    ).toThrow(/not a valid JSON object/);
  });

  it("is idempotent: a second run keeps every file", () => {
    const files: Record<string, string> = { "CLAUDE.md": "# mine\n" };
    const tools = [
      "claude-code",
      "codex",
      "cursor",
      "gemini-cli",
      "copilot",
      "windsurf",
      "cline",
      "kiro",
    ];
    for (const f of planIntegrations(tools, "git", reader(files))) files[f.path] = f.content;
    const again = planIntegrations(tools, "git", reader(files));
    expect(again.every((f) => f.action === "keep")).toBe(true);
    expect(files["CLAUDE.md"]).toBe("# mine\n\n@AGENTS.md\n");
  });

  it("stealth mode puts the rules in CLAUDE.local.md and never touches existing shared files", () => {
    const plan = planIntegrations(
      ["claude-code", "gemini-cli"],
      "stealth",
      reader({ "GEMINI.md": "# shared\n", "CLAUDE.md": "# shared\n" }),
    );
    expect(plan.map((f) => [f.path, f.action])).toEqual([
      ["CLAUDE.local.md", "create"],
      [".mcp.json", "create"],
      [".claude/settings.local.json", "create"],
      [".claude/skills/sati/SKILL.md", "create"],
      ["GEMINI.md", "skip"],
      [".gemini/settings.json", "create"],
    ]);
    expect(plan[0]?.content).toBe(RULES_BLOCK);
  });

  it("stealth mode still updates files git ignores, so a later sync can refresh them", () => {
    const plan = planIntegrations(
      ["kiro"],
      "stealth",
      reader({ ".kiro/steering/sati.md": "stale" }),
      (p) => p === ".kiro/steering/sati.md",
    );
    expect(plan[0]).toMatchObject({ action: "update" });
  });
});
