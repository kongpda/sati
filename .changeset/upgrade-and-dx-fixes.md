---
"@kongpda/sati": minor
---

`sati init --upgrade` now also updates the agent files (rules block, MCP and Claude Code settings), so one command brings a project up to date; `sati doctor` lists out-of-date files with the fix; `sati init --dry-run` shows what would be written. The pre-push hook checks the branch being pushed instead of the checked-out one. On wide screens the board stays usable beside the task panel, which asks before dropping unsaved edits. Fixes: `sati handoff <id>` with no flags reads the handoff instead of wiping it; `restore` accepts short handles; `--body -` and `plan import -` read stdin; clearer errors for a missing plan file, completing an unclaimed task and `serve` outside a project.
