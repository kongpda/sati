# Plan: sati in the terminal, with no server

- Status: proposed (2026-11-12). Not started. Needs the owner's go-ahead and a block in `PLAN.md` before any code.
- Asked by the owner: use sati without its server, headless, with an interactive CLI; can an agent talk to it with or without a server; does MCP need a server.

## Short answers

| Question | Answer |
|---|---|
| Does sati need a server? | No. Every command opens the SQLite database itself. `sati task list` takes about 0.18 s from a cold start (measured 2026-11-12 on this repo). |
| Does MCP need a server to be started? | No. `sati mcp` speaks over stdio. The agent's client starts it and stops it. Nothing listens on a port and nothing runs between sessions. |
| Can an agent work with no MCP at all? | Yes, today. Every command takes `--json`, and the rules block in `AGENTS.md` already lists the command for each step. |
| What is `sati serve` for? | Only a database on a network drive or a Docker / WSL bind mount, where SQLite's WAL is unsafe. One process owns the file and the others use a local socket. On a local disk it is never needed. |
| What is `sati ui` for? | The board in a browser. It is the only HTTP server, it binds to 127.0.0.1, and it is optional. |
| So what is missing? | A person in a terminal cannot do comfortably what the board does. That is the work in this plan. |

## What is missing today

Checked against the code at `7a6deb4`.

1. **No inbox in the terminal.** The board's My work page (approvals, questions from agents, mentions, assigned and due tasks) is computed in `packages/ui/src/my-work.tsx`. The CLI and MCP cannot ask for it.
2. **Prompts exist in two places only**: `sati init` and `sati task claim --pick`. A missing argument elsewhere is a usage error, even for a person at a terminal.
3. **Approving is hidden.** It is `sati task update <id> --status done`; sending back is `--status todo --reason "…"`. The board has two buttons.
4. **No live view.** The board updates as agents work. The terminal has `sati activity`, which prints once.
5. **Bare `sati` prints help.** A person who types `sati` learns the commands but sees nothing about the project.
6. **Agents without MCP get no nudge to use the CLI well**: the brief does not say which form it is talking to.

## Recommendation

Keep the architecture. Add no daemon and no new server. Build a **prompt layer for people** over the commands that exist, and move the inbox into the core so that the CLI, MCP and the board share one answer.

Decided against, with the reason:

- **A full-screen terminal UI** (ink, blessed). It needs a new dependency and an ADR, takes over the screen so scrollback and copy are lost, and reads badly in a screen reader. The board already is the rich view. Prompts in the normal scroll, as `task claim --pick` does now, are enough.
- **A long-lived background daemon to make commands faster.** 0.18 s per command is not a problem to solve, and a daemon brings stale processes after an upgrade, a second way for everything to fail, and a socket to secure.
- **A REPL (`sati shell`)**. It saves typing the word `sati` and costs a second parser, a history file and its own completion. The home screen below covers the need.

## Rules for every interactive feature

These keep the CLI safe for scripts and agents. They are the rules `task claim --pick` already follows.

1. A prompt appears only when stdin and stdout are a terminal, the caller is a person (`CLAUDECODE` and `AI_AGENT` unset), and `--json` is not given. Otherwise the command behaves exactly as today: same output, same exit code.
2. `SATI_NO_INPUT=1` and a global `--no-input` turn prompts off for a person as well.
3. Everything a prompt can do, a flag can do. No action exists only in interactive form.
4. After an interactive action the CLI prints the command that would do the same, dimmed: `sati task update tsk_8f3k2a --status done`. People learn the flags, and can paste them into a script.
5. Ctrl-C or Esc writes nothing and exits as `task claim --pick` does today.
6. Stored text (titles, comments) goes through the existing terminal sanitiser before it is shown in a prompt, flattened to one line.
7. `@clack/prompts` is imported lazily, so commands that do not prompt keep their start time.
8. No new dependency. `@clack/prompts` 1.8.1 is already in `packages/cli`.

## Design

### A. The inbox in the core

- Move the pure function `myWork(snapshot)` from `packages/ui/src/my-work.tsx` to `packages/core/src/services/inbox.ts` as `inbox(reader, ctx, actorId)`. It returns `{ needsAnswer, approval, mentions, assigned, due }`, each a list of ids with the fields a row needs.
- The board calls it through a new `/api/inbox` route, or keeps computing from the snapshot with the same function imported from core. Pick the second: no new route, one implementation.
- New command `sati inbox`: sections in the rich layout, one line per item in the plain layout, the full object with `--json`.
- New MCP tool `inbox`, so an agent can see what waits on the person it works for. Read-only.
- Tests: the existing `packages/ui/test/my-work.test.ts` cases move to core unchanged, so the board's behaviour is pinned while the code moves.

### B. Verbs for review

- `sati task approve [id] [--commit <sha>]`: the same write as `task update --status done --approved-commit`. People only, as now.
- `sati task send-back [id] --reason "…"`: the same write as `--status todo --reason`.
- With no id and a person at a terminal: a picker over the tasks in review. With no id otherwise: usage error.
- No new core code: both call `updateTask`. The old flags keep working.

### C. Prompts for missing arguments

One helper in `packages/cli/src/runtime.ts`:

```ts
/** The value typed for a missing argument, or a USAGE error where nobody can be asked. */
async function ask(kind: "text" | "select" | "confirm", opts): Promise<…>
```

Used by, in this order of value:

| Command | Asked when missing |
|---|---|
| `task create` | title; then priority with the default selected |
| `task show`, `task update`, `task claim`, `task approve`, `task send-back` | which task: a picker, filtered to the tasks the verb can act on |
| `task complete` | summary; files touched, offered from `git diff --name-only` against the task's branch base |
| `comment add` | which record, then the text |
| `note create`, `decision record` | title, then body in `$EDITOR` when it is set, else one line |

`task claim --pick` becomes the general picker: one function, `pickTask(ctx, filter)`, replaces the code in `commands/task.ts`. The picker shows handle, status, priority and title, in the order `task list` uses, and filters as the person types.

### D. A home screen for bare `sati`

`sati` with no command, for a person at a terminal, prints a short status and a menu. Everywhere else it prints help as today.

```
sati  Agent Brain  ·  main

  Needs you    2 to approve, 1 question
  In progress  3 (2 agents working now)
  Ready        5

? What next
  ❯ Inbox
    Claim a task
    New task
    Search
    Recent activity
    Open the board
    Quit
```

- Each entry runs the existing command's function, then returns to the menu. Quit, Esc and Ctrl-C leave.
- The status lines are three counts from one read transaction.
- No alternate screen: output stays in the scrollback.
- `sati --help` and `sati help` still print help. The first line of the menu screen says `sati --help for commands`.

### E. A live view without the board

- `sati activity --follow`: prints new rows as they are written. It polls SQLite's `PRAGMA data_version` every 250 ms, the same signal the board's event stream uses (`packages/cli/src/ui/server.ts`), and reads only when it changed. Ctrl-C stops it. Works in a pipe; `--json` prints one JSON object per line.
- `sati task list --board`: the columns of the board as text, once. Narrow terminals stack the columns. Combine with `watch -n 2` for a refreshing view; no refresh loop of our own.

### F. Agents with no MCP

Already works. Three small changes make it deliberate:

- `sati brief` ends with one line naming the form in use: `Tools: MCP` or `Tools: CLI (--json on every command)`. Detected as today, from how the process was started.
- `sati rules` gains `--cli-only`, which writes the rules block with commands in place of tool names for agents that have no MCP client.
- A guide page, `docs/guide/headless.md`: what runs when, the table from the top of this plan, and a worked session with no MCP and no board.

Not planned: a batch mode that takes many commands on stdin. Measure first; at 0.18 s a command, an agent's session spends well under a second in sati's start-up.

## Phases

Each phase ends with `pnpm lint && pnpm typecheck && pnpm test` and the Playwright board tests green, a changeset, and a `docs/progress.md` entry. One phase per commit series; do not start the next before the gate passes.

### Phase H1: inbox in the core (about 1 day)

- [ ] `packages/core/src/services/inbox.ts` with the function and its Zod output schema
- [ ] The board imports it; `my-work.tsx` keeps only rendering
- [ ] `sati inbox` with rich, plain and `--json` output
- [ ] MCP tool `inbox`
- [ ] Tests moved from `packages/ui/test/my-work.test.ts`; one CLI test per section; one MCP test

Gate: the board's My work page shows the same items as before for the e2e fixtures, and `sati inbox --json` lists the same ids.

### Phase H2: review verbs and the picker (about 1 day)

- [ ] `pickTask(ctx, filter)` replaces the code behind `task claim --pick`
- [ ] `task approve`, `task send-back`
- [ ] Picker for `task show`, `task update`, `task claim` when the id is missing and several tasks qualify
- [ ] The dimmed "same as" line after each interactive action
- [ ] `--no-input` and `SATI_NO_INPUT`
- [ ] Pseudo-terminal tests with `packages/cli/test/support/pty-run.py`: pick and approve; cancel writes nothing; an agent variable set means no prompt and the old usage error

Gate: every existing CLI test passes unchanged. That proves scripts and agents see no difference.

### Phase H3: prompts for missing arguments (about 1 to 2 days)

- [ ] `ask` helper
- [ ] `task create`, `task complete`, `comment add`, `note create`, `decision record`
- [ ] `$EDITOR` for bodies, with a temp file removed afterwards and an empty file meaning cancel
- [ ] Pseudo-terminal test per command; a test that a piped stdin never prompts

### Phase H4: home screen and live view (about 1 to 2 days)

- [ ] Bare `sati` home for a person at a terminal
- [ ] `activity --follow`
- [ ] `task list --board`
- [ ] Performance check added to the budgets: home screen drawn in under 300 ms on the 5,000-task fixture; `--follow` idle cost under 1% of one core

### Phase H5: agents and docs (about half a day)

- [ ] `Tools:` line in the brief
- [ ] `rules --cli-only`
- [ ] `docs/guide/headless.md`, README section, completions regenerated for the new commands and flags

Total: about 5 to 7 working days.

## Risks

| Risk | Mitigation |
|---|---|
| A prompt appears where a script runs, and the script hangs | Rule 1; the gate of H2; a test that runs every command with stdin closed and a 5 s limit |
| Bare `sati` changing from help to a menu surprises people | Only for a person at a terminal; `--help` unchanged; `SATI_NO_INPUT=1` restores help |
| The picker is slow on a large project | It reads the same list `task list` reads, capped at the first 200 rows, with type-to-filter |
| Moving `myWork` changes what the board shows | The tests move first and unchanged; the e2e suite runs before the merge |
| `$EDITOR` leaves secrets in a temp file | File made with mode 0600 in the OS temp folder and removed in a `finally` |
| Pseudo-terminal tests do not run on Windows | They skip there, as now. The non-interactive path, which is what Windows CI covers, is unchanged |

## For the owner to decide

1. Should bare `sati` open the home screen, or should that be `sati home` with bare `sati` left as help? Recommended: bare `sati`, because it is what a new person types first.
2. Should an agent be allowed to call the MCP `inbox` tool for the person it works for? Recommended: yes, read-only. It is the same data the brief already draws from.
3. Is `$EDITOR` for note and decision bodies wanted, or one-line input only? Recommended: `$EDITOR` when set.
4. Phase order. Recommended as written: H1 and H2 give most of the value in two days.
