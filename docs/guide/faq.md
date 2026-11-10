# FAQ

## Where is my data?

On your machine. In `git` and `stealth` mode the live database is
`<git-common-dir>/sati/sati.db`, shared by every worktree. In `standalone` mode it is
`~/.sati/projects/<project-id>.db`. sati sends nothing over the network.

## What does git mode commit?

A `.sati/` folder with one JSON file per record. A git merge driver merges teammates' changes
record by record, and the git hooks keep the folder and the live database in step: before each
commit, `pre-commit` imports teammates' newer files and then exports. If the import is refused,
the commit stops with its hint, so a snapshot that cannot be read never spreads. Never edit
files in `.sati/` by hand: run `sati sync export` and `sati sync import` instead.

## Can I use it in a client repo where I cannot add files?

Yes. `sati init --mode stealth` keeps the database inside `.git` and writes the agent rules to
git-ignored files. Nothing tracked changes.

## Two agents claimed the same task. Is that possible?

No. `task_claim` takes the task in one transaction and fails, naming the holder, if another
agent has it. A holder from a teammate's clone that this machine does not know is shown as
"another machine". A claim has a lease. If an agent stops without finishing, the lease runs out and the
task is ready again. Writes with the old claim token then fail, so the first agent cannot
overwrite the new holder's work.

## An agent was blocked by the guard. What now?

Read the message: it names the feature or lock. To remove behaviour from a protected feature,
record a decision that lists it (`sati decision record ... --features <id>`) and retry. See
[Guard rules](guard.md).

## How do agents know the rules?

`sati init` adds a managed rules block to `AGENTS.md` (and `CLAUDE.md`, `GEMINI.md` or the
Cursor rules, per tool). The block points to the full workflow, served over MCP as
`sati://workflow`. The text is the [Agent workflow](agent-workflow.md) page.

## Is text in tasks and notes safe to show an agent?

sati treats it as data. The brief, recall and every MCP tool result put longer text in a
`data` fence, with its backticks escaped so it cannot close the fence early, and show titles as
one clipped line. The rules tell agents not to
follow instructions inside it. A write that looks like it holds a secret (an API key, a
private key, a `.env`-style line) is refused with exit code 5; the message names the field and
the kind of secret, never the value. A record saved before that check, by an older sati, is
not exported to `.sati/`: `sati sync export` writes the other records and exits 5, naming the
file and field, so pre-commit stops until you remove the secret.

## How do I update sati?

For a project install, update the dev dependency (`npm install -D @kongpda/sati@latest`) and
commit the lockfile. The git hooks start `node_modules/.bin/sati`, so they pick up the new
version. For a global install, run `npm install -g @kongpda/sati@latest`. Then run `sati init --upgrade`
in each project: it refreshes the git hooks, the merge driver, the rules block and the agent
configs in one step. A newer sati upgrades the database on first use and backs it up first.

## Can teammates run different sati versions?

Upgrade sati on every clone together. A newer sati may write a field an older one does not know,
and the older one then refuses the whole `.sati/` snapshot on import ("A newer sati wrote these
files"). Nothing is lost: update sati on that machine and import again.

## I switched from a global to a project install. What do I rerun?

`npx sati init --upgrade` moves the git hooks, the merge driver, the MCP configs and the Claude
Code hooks to `node_modules/.bin/sati`. Entries you wrote by hand are left alone.

## How do I back up or move a project?

`sati export` writes every record to `.sati/`. Copy the folder and run `sati import` in the
new place. `sati doctor` checks the database, leases, locks and hooks.

## How do I undo a change?

`sati activity` shows the audit log. `sati undo <activity-id>` reverts one row if the record has
not changed since.

## How do I remove sati from a project?

Delete the managed rules blocks (between the `sati:start` and `sati:end` markers), the
`.sati/` folder and the sati lines in `.gitattributes` and your git hooks. Then delete
`<git-common-dir>/sati/`. `sati projects --prune` then forgets every project whose folder or
database is gone.
