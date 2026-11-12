import { GENERAL_WORKFLOW } from "@sati/core";
import { describe, expect, it } from "vitest";
import {
  CLI_RULES_BLOCK,
  GENERAL_CLI_RULES_BLOCK,
  GENERAL_RULES_BLOCK,
  type PlannedFile,
  planIntegrations,
  RULES_BLOCK,
  upsertBlock,
} from "../src/integrations.js";
import { sati, tempRepo } from "./helpers.js";

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

  // Why: in a CRLF checkout (core.autocrlf), init wrote the block in LF and left a stray `\r`
  // line after it, so every fresh clone showed AGENTS.md as changed.
  it("writes the block with the file's CRLF line endings, and keeps it on the next run", () => {
    const crlf = (t: string) => t.replaceAll("\n", "\r\n");
    const user = crlf("# Team rules\n\nUse tabs.\n");
    const once = upsertBlock(user);
    expect(once).toBe(crlf(`# Team rules\n\nUse tabs.\n\n${RULES_BLOCK}`));
    expect(upsertBlock(once)).toBe(once);
    const old = crlf(`${RULES_BLOCK.replace("start v1", "start v0")}After.\n`);
    expect(upsertBlock(old)).toBe(crlf(`${RULES_BLOCK}After.\n`));
  });

  it("keeps the block under 30 lines so it costs little context", () => {
    expect(RULES_BLOCK.trimEnd().split("\n").length).toBeLessThan(30);
    // Review 4.6 added words and kept both blocks within their 2026-11-10 size.
    expect(RULES_BLOCK.length).toBeLessThanOrEqual(1345);
    // Phase 9d added one sentence on Office and PDF cards to the general block.
    expect(GENERAL_RULES_BLOCK.length).toBeLessThanOrEqual(1305);
  });

  // Review 4.6: each gap made an agent's first try fail or skip a step.
  it("tells agents what the first attempt otherwise gets wrong", () => {
    for (const block of [RULES_BLOCK, GENERAL_RULES_BLOCK]) {
      // task_complete without the token fails on a claimed task.
      expect(block).toContain("`task_complete` with the claim token");
      // recall answers "what do we know" before any file is opened.
      expect(block).toContain("`recall` what is known");
      // `light` is only visible in the brief; the agent must know where to look.
      expect(block).toContain("A task the brief marks `light`");
      // The brief is read once; a hook may already have opened the session with it.
      expect(block).toContain("unless the session opened with it");
    }
  });

  it("a general project gets its own rules block and skill, without code steps", () => {
    const plan = byPath(
      planIntegrations(["claude-code", "cursor"], "git", reader({}), undefined, false, "general"),
    );
    expect(plan["AGENTS.md"]?.content).toBe(GENERAL_RULES_BLOCK);
    expect(plan[".cursor/rules/sati.mdc"]?.content).toContain(GENERAL_RULES_BLOCK);
    const skill = plan[".claude/skills/sati/SKILL.md"]?.content ?? "";
    expect(skill).toContain(GENERAL_WORKFLOW);
    expect(skill).not.toMatch(/feature_check|lock_acquire|coding task/u);
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
      deny: [
        "Bash(git commit --no-verify:*)",
        "Bash(git commit -n:*)",
        "Bash(git push --no-verify:*)",
      ],
    });
    expect(
      settings.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0]?.command),
    ).toEqual(["say done", "sati nudge"]);
    expect(settings.hooks.SessionStart).toEqual([
      {
        matcher: "startup|clear",
        hooks: [{ type: "command", command: "sati brief --format=agent --tools=mcp" }],
      },
      {
        matcher: "resume|compact",
        hooks: [{ type: "command", command: "sati brief --format=short --tools=mcp" }],
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

  // A merge that re-sorts keys rewrites lines the user owns, so their order must survive.
  it("keeps the key order of existing Claude Code settings and only appends its own", () => {
    const theirs = {
      model: "opus",
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done", timeout: 5 }] }],
      },
      env: { ZED: "1", ALPHA: "2" },
    };
    const run = (args: string) => [{ type: "command", command: `sati ${args}` }];
    const ours = {
      model: "opus",
      hooks: {
        Stop: [...theirs.hooks.Stop, { hooks: run("nudge") }],
        SessionStart: [
          { matcher: "startup|clear", hooks: run("brief --format=agent --tools=mcp") },
          { matcher: "resume|compact", hooks: run("brief --format=short --tools=mcp") },
        ],
        PreToolUse: [
          { matcher: "Edit|MultiEdit|Write|NotebookEdit", hooks: run("guard --hook") },
          { matcher: "Bash", hooks: run("guard --hook") },
        ],
        Notification: [{ hooks: run("wait --hook") }],
        UserPromptSubmit: [{ hooks: run("wait --hook") }],
      },
      env: theirs.env,
      permissions: {
        deny: [
          "Bash(git commit --no-verify:*)",
          "Bash(git commit -n:*)",
          "Bash(git push --no-verify:*)",
        ],
      },
    };
    const plan = byPath(
      planIntegrations(
        ["claude-code"],
        "git",
        reader({ ".claude/settings.json": `${JSON.stringify(theirs, null, 2)}\n` }),
      ),
    );
    expect(plan[".claude/settings.json"]?.content).toBe(`${JSON.stringify(ours, null, 2)}\n`);
  });

  // Moving between a global and a project install must swap the launcher in place. Leaving the
  // old entry would keep agents on PATH; adding a second would run every hook twice.
  it("switches its own MCP entries and hooks between global and local, never a user's", () => {
    const tools = ["claude-code", "codex", "cursor"];
    const files: Record<string, string> = {};
    for (const f of planIntegrations(tools, "git", reader(files))) files[f.path] = f.content;
    const local = byPath(planIntegrations(tools, "git", reader(files), undefined, true));
    expect(JSON.parse(local[".mcp.json"]?.content ?? "").mcpServers.sati.command).toBe(
      "node_modules/.bin/sati",
    );
    expect(local[".codex/config.toml"]?.content).toBe(
      '[mcp_servers.sati]\ncommand = "node_modules/.bin/sati"\nargs = ["mcp"]\n',
    );
    const hooks = JSON.parse(local[".claude/settings.json"]?.content ?? "").hooks;
    expect(hooks.Stop).toEqual([
      {
        hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/sati nudge' }],
      },
    ]);
    expect(hooks.PreToolUse).toHaveLength(2);
    for (const f of Object.values(local)) files[f.path] = f.content;
    expect(
      planIntegrations(tools, "git", reader(files), undefined, true).every(
        (f) => f.action === "keep",
      ),
    ).toBe(true);

    const mine = { mcpServers: { sati: { command: "npx", args: ["@kongpda/sati", "mcp"] } } };
    const hand = '[mcp_servers.sati]\ncommand = "/opt/sati"\nargs = ["mcp"]\n';
    const kept = byPath(
      planIntegrations(
        ["claude-code", "codex"],
        "git",
        reader({ ".mcp.json": JSON.stringify(mine), ".codex/config.toml": hand }),
        undefined,
        true,
      ),
    );
    expect(kept[".mcp.json"]?.action).toBe("keep");
    expect(kept[".codex/config.toml"]?.action).toBe("keep");
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

// Some agents have no MCP client. Their rules must name commands they can run, and must not
// send them to tools that are not there.
describe("rules for agents without MCP", () => {
  const tools = ["claude-code", "codex", "cursor"];
  const plan = (files: Record<string, string>, cliOnly?: boolean) =>
    planIntegrations(tools, "git", reader(files), undefined, false, "code", cliOnly);

  it("writes the steps as commands, adds no MCP config, and names no MCP tool", () => {
    const files = byPath(plan({}, true));
    expect(files["AGENTS.md"]?.content).toBe(CLI_RULES_BLOCK);
    expect(files[".cursor/rules/sati.mdc"]?.content).toContain("There are no MCP tools here");
    for (const path of [".mcp.json", ".codex/config.toml", ".cursor/mcp.json"]) {
      expect(files[path], path).toBeUndefined();
    }
    for (const block of [CLI_RULES_BLOCK, GENERAL_CLI_RULES_BLOCK]) {
      expect(block).not.toMatch(/task_claim|task_complete|feature_check|context_get|sati_brief/u);
      expect(block.trimEnd().split("\n").length).toBeLessThan(30);
    }
    // The hook's brief must not say "Tools: MCP" to an agent that has none.
    expect(files[".claude/settings.json"]?.content).toContain('"sati brief --format=agent"');
    expect(files[".claude/settings.json"]?.content).toContain('"sati nudge --tools=cli"');
  });

  // `sati upgrade` and a plain `rules sync` run without the flag. They must not undo the choice.
  it("keeps the command form on a later run, until told to go back", () => {
    const files: Record<string, string> = { ".mcp.json": '{ "mcpServers": {} }\n' };
    for (const f of plan(files, true)) files[f.path] = f.content;
    // An MCP config that was there before is the user's: left alone.
    expect(files[".mcp.json"]).toBe('{ "mcpServers": {} }\n');
    expect(plan(files).every((f) => f.action === "keep")).toBe(true);
    const back = byPath(plan(files, false));
    expect(back["AGENTS.md"]?.content).toBe(RULES_BLOCK);
    expect(back[".mcp.json"]?.action).toBe("update");
    expect(back[".claude/settings.json"]?.content).toContain("--format=agent --tools=mcp");
  });

  // A rule that names a command or a flag that does not exist costs every agent a failed call.
  it("names only commands and flags the CLI has", async () => {
    const dir = await tempRepo();
    const named = new Set<string>();
    for (const block of [CLI_RULES_BLOCK, GENERAL_CLI_RULES_BLOCK]) {
      for (const [, command] of block.matchAll(/`sati ([a-z][^`]*)`/gu)) {
        if (command && !command.startsWith("<")) named.add(command);
      }
    }
    expect(named.size).toBeGreaterThan(8);
    for (const command of named) {
      const words = command.split(" ");
      const at = words.findIndex((w) => !/^[a-z][a-z-]*$/u.test(w));
      const path = at < 0 ? words : words.slice(0, at);
      const help = sati(dir, ...path, "--help");
      expect(help.code, command).toBe(0);
      expect(help.stdout, command).toContain(`sati ${path.join(" ")}`);
      for (const flag of command.match(/--[a-z-]+/gu) ?? []) {
        expect(help.stdout, command).toContain(flag);
      }
    }
  });
});
