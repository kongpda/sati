# @kongpda/sati

## 0.2.0

### Minor Changes

- 8b7ac5a: `sati app --shortcut <folder>` writes a file that opens the board of this project on a double click, for a person who does not use a terminal (`.command` on macOS, `.cmd` on Windows, a desktop entry on Linux). `sati app` alone is the same as `sati ui`.
- 784b69e: A person can sign off a file with `sati card approve <file>`. sati stores the SHA-256 of the file's bytes on its card, never the contents. The guard (`sati guard`, the pre-commit hook, the Claude Code edit hook, MCP `feature_check`) then blocks a change, a move or a removal of that file until the new version is approved, also in a general project where the guard was off. An agent sees `approved` on the card from `context_get`. `sati card get` shows `approved`, `CHANGED since it was approved` or `approved file is MISSING`. `--clear` takes the approval away.
- ab9ef9c: At a terminal, `sati task create`, `task complete`, `comment add`, `note create` and `decision record` ask for what you left out, then print the command that does the same. `task complete` offers the files git says you changed. A note's text and a decision are written in `$VISUAL` or `$EDITOR` when one is set; saving an empty file cancels. Scripts, pipes, agents and `--json` are never asked and get the same usage errors as before.
- c46791d: Board: the Memory page can approve a file as it is now and take the approval away, the same as `sati card approve`. Typing `@` in a comment offers the names of the people and agents in the project; the arrow keys choose one, Enter or Tab puts it in.
- e6b13c1: `sati --version` shows the commit the build was made from and that commit's date: `sati 0.1.0 (48a630b 2026-11-11)`, with `48a630b-dirty` when the build had changes that were not committed. `-v` and `-V` print the same line. The MCP server reports `0.1.0+48a630b`. `sati doctor` starts with the environment a bug report needs (version, node, system, install and store paths; `environment` in `--json`), and when sati runs from a source checkout it says when the source has newer code than the build.
- a734fa1: A card can describe a web link (a SharePoint or Drive file, a page) or a file outside the project folder: pass the link or the full path as the card path. Such a card is matched whole, has no automatic stale check (pass `--seen`), and a link with a user name, password or access token is refused. A card for a full path stays on this machine unless made with `--no-private`.
- ce9a572: `sati upgrade` updates a project's git hooks, merge driver and agent files in one short command; it replaces typing `sati init --upgrade --yes`, which still works. `sati completion bash|zsh|fish` prints a tab-completion script. Output taller than the terminal opens in your pager (`SATI_PAGER`, `PAGER`, then `less`); `PAGER=cat` turns that off. `sati review` wraps long lines, and a tab in a title no longer shifts a table column. A group typed alone (`sati task`) prints its help, `sati help <command>` works, and a missing argument shows what to type. `sati task claim --pick` lets you choose from the ready tasks. `sati completion` with no shell follows `$SHELL`.
- 1c35cfc: Output is laid out for the reader. In a terminal, lists are aligned and cut to the window, records show wrapped text and local times, `doctor` marks each check and counts them, `activity` shows who changed what, and finished actions get a check mark. In a pipe the lines stay compact and uncoloured, as before. Colour follows `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`, and every command takes `--no-color`. `sati --help` lists the commands in groups and no longer prints colour codes into a pipe. A wrong command word suggests the right one (`sati task get` says `sati task show`). Titles and notes are printed without terminal control characters, so stored text cannot rewrite the screen. The brief keeps its ready tasks when a long section above them uses up the budget.
- e7fc7a2: `sati inbox`, the MCP `inbox` tool and the home screen of a bare `sati` read open tasks and the notes of the last two weeks, not every record: on a project of 50,000 records with 1 task in 10 open, `sati inbox` went from 289 ms to 141 ms. `sati init --cli-only` sets a new project up for agents with no MCP client in one step.
- e9f94b6: `sati task show`, `sati task complete`, `sati task release` and `sati handoff` no longer need a task id when you hold exactly one task. With none or several they ask which, and list them. Validation errors are shorter: `Invalid input: priority: expected one of low, medium, high, urgent`.
- 390e001: `sati` typed alone at a terminal shows what needs you, what is in progress and what is ready, then a menu of the common commands; each entry runs the command you could have typed. `sati task list --board` prints the board's columns as text: side by side in a wide terminal, stacked in a narrow one, one line per task in a pipe, and grouped by column with `--json`. `sati activity --follow` prints the last rows and then each new row as it is written, one JSON object per line with `--json`, until Ctrl-C. Scripts, pipes and agents still get the help text and exit code 2 from a bare `sati`.
- d643a27: The board's "My work" page is now the inbox. Write `@name` in a comment and it shows under "Mentions" for that person, until they answer on the same record or 14 days pass. The link to "My work" and the browser tab show how many things wait for you: questions and permissions from agents, blocked tasks, work to approve and mentions.
- 09bf6ae: `sati doctor` has a `lean` line: cards that describe a file that is gone, and finished tasks older than 90 days. `sati doctor --fix` releases expired locks and removes those cards; each removal is logged. A card for a file on another git branch is kept.
- 24b57b6: Office wiring: `sati init --desktop` prints the Claude Desktop entry for a project, and `--project` takes the project folder as well as a slug, so a desktop app can start the server from anywhere. Agents without a shell can write a handoff (`handoff_write`) and tick or add checklist steps (`task_update` with `tick` and `addSteps`). The general rules and workflow say how to keep cards for Word, Excel, PowerPoint and PDF files. Four new starter templates: `content-calendar`, `monthly-report`, `proposal`, `meeting-notes`.
- d74c7ef: Only a person can approve a file or take its approval away; an agent that runs `sati card approve` is refused. The brief and the board's Memory page now say when an approved file changed or is gone since its approval. A comment that calls an agent by name (`@claude-code`) shows in that agent's brief until any session of that agent answers on the same record. The brief no longer misses a lost claim on a day with more than 200 writes.
- 7a23b27: `recall` ranks better and every command starts faster.
  
  - `recall` lifts records written in the last week or month, and the card of a file that has
    uncommitted changes, above older records that match the question equally well.
  - The current branch is read from the `HEAD` file, which saves one `git` start per command.
  - Hashing changed files no longer slows down with the number of files in the repository.
- af9c54b: `sati task approve` and `sati task send-back --reason "…"` are the terminal's two review buttons. At a terminal you may leave the task id out of them, and out of `task update`, `task show` and `task claim`: sati shows a list to choose from, then prints the command that does the same. Scripts, pipes, agents and `--json` are never asked. `--no-input` or `SATI_NO_INPUT=1` turns the questions off for a person too.
- bcd34e3: A project outside git can be shared through a synced folder (Dropbox, OneDrive, iCloud Drive, a file server). `sati init --share`, or `sati sync share` for an existing standalone project, keeps the records as files in `.sati/`; the database stays in `~/.sati/` on each machine. Another person runs `sati init` in the synced folder to join. Every command, the board and the MCP server load the files that changed, and a "conflicted copy" the sync app made of a record is merged into it field by field and deleted. Changes arrive at the speed of the sync app; live claims and file locks across people still need the hosted server. See ADR 0009.
- ac10737: `sati inbox` shows in the terminal what the board's My work page shows: questions agents ask you, blocked tasks, comments that mention you, tasks to approve, tasks assigned to you and tasks due this week. `--json` gives the same lists to scripts, `--for` shows another person's. Agents get the same answer from the new read-only MCP tool `inbox`.
- dfa30a0: The brief ends with a line that names the form to use: `Tools: MCP.` from the MCP server and the session-start hook, `Tools: CLI (--json on every command)` when run as a command (`sati brief --tools mcp|cli` sets it). `sati rules sync --cli-only` writes the rules block as commands for agents with no MCP client and adds no MCP configs; later syncs keep that form and `--no-cli-only` goes back. Run `sati upgrade` once so the Claude Code hook passes `--tools=mcp`. New guide: `docs/guide/headless.md`.

### Patch Changes

- 7d1e3e9: Fix findings from the audit in the board.
  
  - Moving one card twice in a row no longer shows a conflict: the second move waits for the first.
  - "N of M tasks did not move" stays until it is closed.
  - Esc closes a form dialog when focus is outside its form.
  - `x` and Enter act only on the board, so a card that is not shown cannot be selected.
  - Search in a general project no longer offers features, whose page is hidden there.
  - The project kind choice in Settings cannot stay locked after a failed reload.
- f5cf615: More fixes from the audit, in the CLI.
  
  - Git hooks let a commit through, with a hint, when the recorded `node` is gone. Before, only the script was checked and every commit was blocked.
  - `sati doctor` reads the hook command correctly when its path has an apostrophe, and no longer offers to remove the worktree it runs in.
  - `sati init --upgrade` refuses `--mode`, `--kind`, `--name` and `--slug` instead of ignoring them.
  - `sati review` gives the same verdict as `sati guard`: it uses the project's `maxRemovalRatio` and skips general projects.
  - Worktree paths are compared through their real path, so `/tmp` and `/private/tmp` match on macOS.
  - The merge driver and the `.sati/` export retry a rename that Windows refuses for a moment.
- c7c356b: Fix findings from the audit in core and the CLI.
  
  - `sati doctor` lists every record the merge driver flagged for review, not only tasks. `sati doctor --reviewed <id>` clears the flag after a person has read the record.
  - `plan import --dry-run` and `template apply --dry-run` now refuse what the real run refuses: a secret, a title that is too long, a milestone name that exists.
  - The shell guard no longer reads `git commit -m -n` as `--no-verify`, reports the right target for `mv dir/ dest/`, and sees the removal of a husky hook file.
  - `sati review` and `sati scan` read every feature and every task in review, not the first 500.
  - Two `sati init` runs at the same time no longer drop a project from `sati projects`.
  - A personal workspace folder that is missing from the project list gives a clear message instead of `EEXIST`.
- 05d1ec8: Fixes from a full-project audit.
  
  - A note or task with a long run of spaces on one line no longer freezes the secret check (it took over 20 seconds on a 100 KB line).
  - A lock or guard path written as `src/./a.ts` now covers `src/a.ts`.
  - Through `sati serve`, `task list --ready` no longer fails with "No task with id null", and a malformed message no longer stops the server.
  - `sati projects` no longer creates an empty database for a project whose database is gone; it shows `ready -1`.
  - `sati changes` lists every blocked and overdue task, not only the first 500.
- b4469b1: Fix findings from the audit in the store and the MCP server.
  
  - The network-drive warning now works on macOS (the filesystem type was read wrongly, so it never fired).
  - `sati serve` names the limit when the socket path is too long, instead of a bare `EINVAL`.
  - When git fails inside a repository, the error keeps git's own message, and says to leave `.git` when run inside it. A standalone project below a broken `.git` opens again.
  - MCP tool errors come back in the same data fence as results.
  - Faster writes: the search index is rewritten only when a record's text changes. New indexes find a milestone's tasks and features.
- f6483a6: The board no longer offers an action the server refuses.
  
  - Dragging a card dims the columns it cannot go to and says why; a refused drop sends nothing. The bulk "Move to" menu and the status list in the task panel show only where the task can go.
  - Sending work back from review asks what still needs doing, from the panel, a drag or the bulk menu.
  - A task someone else is working on is marked on its card and locked in the panel until it is taken over or released. "Take over" shows only where the task can be claimed again.
  - A board started from an agent's terminal says so, and does not offer what only a person may do: approving work, taking a task from someone, editing people.
  - A bulk move lists each reason with the number of tasks it stopped.
  - The task title is required in the panel; a note cannot take the tag kept for comments.
  - Refusals use the board's words for statuses and leave out record ids.
  - `sati projects` says "database not readable" where it printed `ready -1`.
- fe3808b: A task that waits for unfinished tasks can no longer be claimed by id. The brief no longer reports a feature's folder path as matching no file. A person can edit a task whose claim has expired.
- cc73aea: Update the board's dependencies: React 19.3, TanStack Query 5.105, TanStack Virtual 3.14 and Tailwind 4.3. The board is built with Vite 8.
- f2d334c: The CLI refuses words it has no place for (`sati task create Fix the bug` made a task named "Fix"; quote the title), an `update` with no option, and an `activity --since` it cannot read. A write on a task someone else holds now says who is in the way instead of telling you to claim it. `sati undo` prints one line and `sati task show` prints the checklist as numbered steps. A full disk or a read-only folder is no longer reported as a bug in sati. The board shows an error screen with Reload in place of a white page, and its "working now" strip leaves out agents whose lease has ended.
- 1e659ba: The board shows who holds a task as a bordered badge on the card, so it no longer reads as part of the time.
- f6f8de9: Cards can tell staleness from the caller: `sati card get <path> --seen <version>` and `context_get` with `seen` compare the file's version now with the one the card was saved with. A card path may name a part of a file (`budget.xlsx#Sheet2`, `deck.pptx#slide-12`, `contract.pdf#p4`) and goes stale when the file changes. A card saved while its file had uncommitted changes stays fresh when the same content is committed.
- 6cc3d35: An MCP client that sets no agent variable (Claude Desktop, Cursor) is now recorded as an agent named after the client, not as the person, so it cannot pass the review gate. Lock, guard and feature paths match without regard to letter case or Unicode form. `sati card put|get` and `sati lock acquire` take a path relative to the current folder or an absolute path inside the project. `sati init` outside a git repository defaults to kind `general`, shows the kind in `--dry-run`, and refuses the home folder and the top of the disk.
- 8d7e5a2: `recall`, `search` and the duplicate-task check now find words in Thai, Khmer, Lao, Burmese, Chinese and Japanese text, which is written without spaces between words.
- 93a3628: A pull no longer drops a local edit that was not exported yet: import merges a record field by field whenever the database and the file changed apart, at any version. The snapshot reader accepts a byte-order mark and skips copies a file-sync app made (`name (1).json`, conflicted copies) with a warning. Snapshot files are flushed before the rename. `sati serve` clients no longer hang after a failed commit, and give up on a daemon that does not answer in 60 seconds. NTFS and exFAT disks on Linux (`fuseblk`) count as local. `sati init` and `sati doctor` warn when the database is inside a Dropbox, OneDrive, Google Drive, iCloud or Box folder.
- 7a6deb4: An option given twice is refused instead of keeping only the last value. On the board, a delete's Undo is no longer replaced by the next message, and text typed right after picking an `@name` in a comment is no longer scrambled. Only the 5 newest database backups are kept.
- 3b95031: Shared folder: one record file that cannot be read (half synced, damaged) no longer holds back the other changes; it is left out with a warning and tried again. When two people claim one task before their files meet, the one whose claim was replaced is told at the load and in their next brief. A config file written by a newer version now says so instead of only "Invalid".

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
