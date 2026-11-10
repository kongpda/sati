# @kongpda/sati

## 0.1.0

### Minor Changes

- 6b55d5e: First release of sati: shared memory and traffic control for AI coding agents.
  
  Run Claude Code, Codex, Cursor, Gemini CLI and other agents in one repository at the same time. sati gives them one list of tasks, one record of decisions and one set of rules, so they do not take the same task, edit each other's files or delete code that already ships.
  
  - Tasks with claims and leases: an agent claims a task before it codes, and nobody else can take it. Subtasks, dependencies, checklists, due dates, assignees and milestones.
  - Effort routing: a `light` task can go to a subagent on a small, cheaper model.
  - `sati brief`: an agent's task, the ready queue and what changed since its last session, in one short read.
  - Protected features: the guard blocks deleting or gutting shipped code in editor hooks, git hooks, `sati review` and CI.
  - Path locks, decisions, notes and file cards, so agents do not collide or repeat work. `recall` and `search` answer from them.
  - People in the loop: finished work waits for a person to approve or send back, with a reason.
  - A local web board (`sati ui`) with My work, Roadmap, Changes, Memory and an Agents page, and the same operations over MCP (`sati mcp`) and the CLI (`--json`).
  - Local-first: SQLite on your machine, with nothing to compile on install. In git mode a `.sati/` JSON snapshot is committed and merged by a git merge driver; stealth and standalone modes keep everything local.
  - `sati init` sets up Claude Code, Codex, Cursor, Gemini CLI, Copilot, Windsurf, Cline and Kiro: MCP config, a rules block, editor hooks and git hooks.
  - Software and general projects: a general project hides features and agents for non-code work such as events.

### Patch Changes

- 9ddc321: Inside a git repository where `git` cannot run, sati now stops with an error that names git. Before, `sati init` quietly set up a standalone project with no git hooks, and other commands reported that there was no git repository.
