# Quick start

sati is a local-first memory, task and feature manager for AI coding agents. Several agents can
work in one repository and see the same tasks, features and decisions.

## Install

sati needs Node.js 24.15 or newer.

> `@kongpda/sati` is not on npm yet (v0.2.0 is private). Until it is, build it from source and
> install the packed tarball; the commands are in the
> [README](https://github.com/kongpda/sati#install-from-source). Use the tarball path wherever
> this guide says `@kongpda/sati`.

Add it to the project as a dev dependency, so every teammate and CI get the same version from
the lockfile:

```bash
cd my-project
npm install -D @kongpda/sati   # or: pnpm add -D, yarn add -D
npx sati --version
```

Then run every command below through `npx` (`npx sati init`, `npx sati brief`). The agent
configs and git hooks that `init` writes start `node_modules/.bin/sati`, so nothing has to be on
your PATH.

For stealth mode in a client repo, or a project without a `package.json`, install it globally
instead and drop the `npx`:

```bash
npm install -g @kongpda/sati
```

## Set up a project

Run `init` at the root of a git repository:

```bash
npx sati init
```

Each clone needs its own `init`, because the git hooks and the live database live in `.git`. A
teammate runs `npm install`, then `npx sati init`. In a clone, `init` keeps the project id from
the committed config and loads the committed `.sati/` snapshot, so the shared tasks are there at
once. `sati doctor` reports a clone that has no hooks yet.

`init` asks for a mode and the agent tools to set up. To skip the prompts:

```bash
sati init --yes --mode git --tools claude-code,codex
```

| Mode | Live database | What is committed |
| --- | --- | --- |
| `git` (default) | `<git-common-dir>/sati/sati.db` | A `.sati/` snapshot, merged by a git merge driver |
| `stealth` | `<git-common-dir>/sati/sati.db` | Nothing. Rules go into git-ignored files. Use it for client repos. |
| `standalone` | `~/.sati/projects/<project-id>.db` | Nothing. Use it outside git. With `--share`, a `.sati/` snapshot in the folder for a file-sync app. |

### Sharing a folder without git

A team with no git can share a project through the folder it already shares (Dropbox, OneDrive,
iCloud Drive, Google Drive, a file server):

```bash
sati init --share        # a new project in this folder
sati sync share          # or: turn sharing on for an existing standalone project
```

The records are then also kept as small files in `.sati/`, which the sync app carries. The
database stays in `~/.sati/` on each machine, never in the synced folder. Another person opens
the folder once it has synced and runs `sati init`. When two people change the same record
before the sync app meets, sati merges the "conflicted copy" the app leaves and deletes it.

Changes travel as fast as the sync app moves files, not live: two people can claim one task
inside that window, and file locks are not shared. Private notes and cards stay on your machine.

The live database is shared by every worktree of the repository, so agents in parallel
worktrees see the same tasks.

Supported agent tools: `claude-code`, `codex`, `cursor` and `gemini-cli` get a managed rules
block, the MCP server and, where the tool has them, hooks. `copilot`, `windsurf`, `cline` and
`kiro` get the rules block.

After you upgrade sati, refresh the git hooks, the merge driver, `.gitattributes`, the rules
block and the agent configs in one step (the [FAQ](faq.md#how-do-i-update-sati) has the rest):

```bash
sati upgrade
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

For a person who does not use a terminal, write a launcher once:

```bash
sati app --shortcut ~/Desktop
```

It writes a file named after the project (`.command` on macOS, `.cmd` on Windows, a desktop entry
on Linux). A double click starts the board of that project and opens the browser; closing its
window stops the board. The file is not signed, so macOS may ask to confirm the first time.
`sati app` alone is the same as `sati ui`. Install sati first (`npm install -g @kongpda/sati`): a
copy fetched by `npx` is removed from its cache later and the launcher would stop working.

## Health and backups

```bash
sati doctor              # stale leases, orphan locks, DB integrity, hook health
sati doctor --vacuum     # also compact the database
sati doctor --fix        # release expired locks, remove cards whose file is gone
sati doctor --reviewed <id>   # clear the "needs review" flag a merge left on a record
sati export              # write every record to .sati/
sati import              # load records from .sati/ into the live database
```

A backup of the database is written before each schema migration.

## Exit codes

Every command that returns data takes `--json`. Errors print a message and a hint, and exit
with a fixed code:

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

Commands that other tools start follow those tools' rules instead: `sati guard --hook` exits 2
to block an edit, as Claude Code expects, and `sati nudge`, `sati wait --hook` and
`sati merge-driver` exit 1 on any error.
