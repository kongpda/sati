# Quick start

sati is a local-first memory, task and feature manager for AI coding agents. Several agents can
work in one repository and see the same tasks, features and decisions.

## Install

sati needs Node.js 22 or newer.

```bash
npm install -g @kongpda/sati
sati --version
```

## Set up a project

Run `init` at the root of a git repository:

```bash
cd my-project
sati init
```

`init` asks for a mode and the agent tools to set up. To skip the prompts:

```bash
sati init --yes --mode git --tools claude-code,codex
```

| Mode | Live database | What is committed |
| --- | --- | --- |
| `git` (default) | `<git-common-dir>/sati/sati.db` | A `.sati/` snapshot, merged by a git merge driver |
| `stealth` | `<git-common-dir>/sati/sati.db` | Nothing. Rules go into git-ignored files. Use it for client repos. |
| `standalone` | `~/.sati/projects/<project-id>.db` | Nothing. Use it outside git. |

The live database is shared by every worktree of the repository, so agents in parallel
worktrees see the same tasks.

Supported agent tools: `claude-code`, `codex`, `cursor`, `gemini-cli`. For each tool, `init` adds
a managed rules block, the MCP server and, where the tool has them, hooks.

After you upgrade sati, refresh the git hooks, merge driver and `.gitattributes`:

```bash
sati init --upgrade
```

## First task

```bash
sati task create "Add a health check endpoint"
sati next            # claim the top ready task
sati task list
sati brief           # what an agent sees at the start of a session
```

Agents use the same operations through MCP (`task_claim`, `task_update`, `task_complete` and
others). The rules they follow are in [Agent workflow](agent-workflow.md).

## Protect what works

Register a feature, and mark it shipped and protected once it works:

```bash
sati scan       # propose features from top-level folders
sati feature create "Billing" --paths 'src/billing/**' --status shipped --protected
```

The guard then warns when an agent edits those paths, and blocks when it deletes or guts them. See
[Guard rules](guard.md).

## Web board

```bash
sati ui
```

`sati ui` serves a board on `127.0.0.1` and opens a browser. Use `--no-open` to print the
sign-in URL only. The URL holds a one-time token; do not share it.

## Health and backups

```bash
sati doctor              # stale leases, orphan locks, DB integrity, hook health
sati doctor --vacuum     # also compact the database
sati export --all        # write every record to .sati/
sati import              # load records from .sati/ into the live database
```

A backup of the database is written before each schema migration.

## Exit codes

Every command takes `--json`. Errors print a message and a hint, and exit with a fixed code:

| Code | Meaning |
| --- | --- |
| 1 | Internal error (a bug) |
| 2 | Usage error |
| 3 | Not found |
| 4 | Conflict, for example a task another agent holds |
| 5 | Validation error |
| 6 | Not initialized |
| 7 | Database schema is newer than this sati |
| 8 | Invalid status transition |
| 9 | Ambiguous short id |
| 10 | `sati guard` found a blocked change |
