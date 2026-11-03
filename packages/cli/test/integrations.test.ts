import { describe, expect, it } from "vitest";
import {
  type PlannedFile,
  planIntegrations,
  RULES_BLOCK,
  upsertBlock,
} from "../src/integrations.js";

const reader = (files: Record<string, string>) => (path: string) => files[path];
const byPath = (plan: PlannedFile[]) => Object.fromEntries(plan.map((f) => [f.path, f]));

// These files belong to the user. brain may only own the text between its markers
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
    expect(Object.keys(plan).sort()).toEqual([".mcp.json", "AGENTS.md", "CLAUDE.md"]);
    expect(plan["CLAUDE.md"]?.content).toBe("@AGENTS.md\n");
    expect(JSON.parse(plan[".mcp.json"]?.content ?? "")).toEqual({
      mcpServers: { brain: { command: "brain", args: ["mcp"] } },
    });
  });

  it("merges into existing MCP configs and leaves a user's own brain entry alone", () => {
    const mine = { mcpServers: { brain: { command: "npx", args: ["@scope/brain", "mcp"] } } };
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
      mcpServers: { db: { command: "db-mcp" }, brain: { command: "brain", args: ["mcp"] } },
      theme: "dark",
    });
    expect(plan[".codex/config.toml"]?.content).toBe(
      'model = "o5"\n\n[mcp_servers.brain]\ncommand = "brain"\nargs = ["mcp"]\n',
    );
    expect(plan[".cursor/rules/brain.mdc"]?.content).toMatch(/^---\n.*\nalwaysApply: true\n---\n/);
  });

  it("refuses to overwrite an MCP config it cannot parse", () => {
    expect(() =>
      planIntegrations(["claude-code"], "git", reader({ ".mcp.json": "{ nope" })),
    ).toThrow(/not valid JSON/);
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
      ["GEMINI.md", "skip"],
      [".gemini/settings.json", "create"],
    ]);
    expect(plan[0]?.content).toBe(RULES_BLOCK);
  });

  it("stealth mode still updates files git ignores, so a later sync can refresh them", () => {
    const plan = planIntegrations(
      ["kiro"],
      "stealth",
      reader({ ".kiro/steering/brain.md": "stale" }),
      (p) => p === ".kiro/steering/brain.md",
    );
    expect(plan[0]).toMatchObject({ action: "update" });
  });
});
