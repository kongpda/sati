---
"@kongpda/sati": minor
---

The brief ends with a line that names the form to use: `Tools: MCP.` from the MCP server and the session-start hook, `Tools: CLI (--json on every command)` when run as a command (`sati brief --tools mcp|cli` sets it). `sati rules sync --cli-only` writes the rules block as commands for agents with no MCP client and adds no MCP configs; later syncs keep that form and `--no-cli-only` goes back. Run `sati upgrade` once so the Claude Code hook passes `--tools=mcp`. New guide: `docs/guide/headless.md`.
