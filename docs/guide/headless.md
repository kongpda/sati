# sati in the terminal, with no server

sati needs no server. Every command opens the project's SQLite database itself, does one thing
and exits. This page says what runs when, how a person works from the terminal alone, and how an
agent works with no MCP client.

## What runs when

| You run | What it starts | When it stops |
| --- | --- | --- |
| Any command (`sati task list`, `sati inbox`, …) | One short process that opens the database | When the command is done, in about 0.2 s |
| `sati mcp` | The MCP server on stdio. The agent's client starts it; you do not | When the client closes it. Nothing listens on a port |
| `sati ui` | The board, an HTTP server on 127.0.0.1 | Ctrl-C. Optional: nothing else needs it |
| `sati serve` | One process that owns the database file, with a local socket | Ctrl-C. Only for a database on a network drive or a Docker / WSL bind mount |
| `sati activity --follow` | One process that prints new activity rows | Ctrl-C |

Nothing runs between sessions. There is no background process to restart after an upgrade.

## A person, with no board

Type `sati` alone. You get a short status and a menu:

```text
sati  Demo  ·  main  sati --help for commands

  Needs you    2 to approve, 1 to answer
  In progress  3 (2 with a live claim)
  Ready        7

◆  What next
│  ● Inbox (what waits for you)
│  ○ Claim a task
│  ○ New task
│  ○ Search
│  ○ Recent activity
│  ○ Open the board
│  ○ Quit
```

Each entry runs the command you could have typed, and prints that command first. What the board
does, as commands:

| On the board | In the terminal |
| --- | --- |
| My work | `sati inbox` |
| Approve, or send back with a note | `sati task approve`, `sati task send-back` |
| The columns | `sati task list --board` |
| Changes as they happen | `sati activity --follow` |
| New task, comment, note, decision | `sati task create`, `sati comment add`, `sati note create`, `sati decision record` |

Leave an id or an argument out and sati asks for it: a list of tasks to pick from, a line to
type, or your editor (`$VISUAL`, then `$EDITOR`) for longer text. After each answer it prints
`Same as: sati …`, the full command, so you can copy it into a script. Ctrl-C or Esc at a
question changes nothing.

`sati task list --board` prints once. For a view that refreshes, use `watch -n 2 sati task list --board`.

## When sati asks, and when it never does

A question appears only when all of these hold:

- standard input and standard output are a terminal;
- no agent variable is set (`CLAUDECODE=1` or `AI_AGENT`);
- the command has no `--json`;
- neither `--no-input` nor `SATI_NO_INPUT=1` is set.

In every other case a missing argument is a usage error with exit code 2, as it always was, and
a bare `sati` prints the help text. A script, a pipe, a CI job or an agent is never left waiting
at a prompt.

## An agent, with no MCP

Every step of the workflow is a command, and every command takes `--json`. Set the project up
for it once:

```bash
sati init --cli-only          # a new project
sati upgrade --cli-only       # a project that already has sati
```

This writes the rules block in `AGENTS.md` (and the other rules files) with a command for each
step in place of the MCP tool names, and adds no MCP configs. An MCP config that is already
there is left alone. Later runs of `sati upgrade` keep the command form;
`sati upgrade --no-cli-only` goes back.

A session then looks like this:

```bash
sati brief                                   # who you are, your tasks, what is ready
sati recall "how does login work" --json     # what is already known
sati task claim --json                       # the top ready task; note claim.token
sati guard --paths src/login.ts              # before deleting, moving or rewriting
sati lock acquire "src/login/**" --json      # before editing a shared area
sati card get src/login.ts --json            # before opening a file
sati decision record "Keep cookies" --decision "Tokens in cookies, not local storage"
sati task complete --summary "Login form validates" --files src/login.ts
```

`sati task complete`, `sati task show` and `sati handoff` act on the task you hold, so they need
no id. The claim's token is kept for you; pass `--token` only when a command asks for it.

The brief ends with a line that names the form to use:

- `Tools: MCP.` when the brief came from the MCP server, or from the session-start hook that
  sati writes next to an MCP config (`sati brief --tools=mcp`);
- `Tools: CLI (--json on every command). …` when it was run as a command.

Exit codes are the contract for scripts: 0 is success, 2 is a usage error, and the others are
listed in [Quick start](quick-start.md).

## Both at once

MCP, the CLI and the board read and write the same database, each in short transactions, so they
can be mixed freely: agents on MCP, a person in the terminal, and the board open in a browser.
