# Ideas

Ideas not in `PLAN.md`. Do not build these without adding them to the plan first.

- **Terminal board** (`sati board`): a kanban view in the terminal for people who never open the web UI. Raised 2026-11-03 with the daily-workspace items; deferred because Phase 4 builds the real board.
- **Write ticks back to Markdown**: when a task imported by `sati plan import` completes, tick its `- [ ]` line in the source file. Deferred: editing user files from a background write is surprising and conflicts with hand edits.
- **Import from GitHub Issues or Linear**: one-way import into tasks for teams moving to sati. Deferred: the plan's non-goals say sati does not replace issue trackers.
- **Unattended agent runner**: a `sati work` loop that starts an agent per ready task. Deferred: `autoContinue` plus the review gate covers the safe version; spawning agents is out of scope.
- **Standalone binary built with Bun**: `bun build --compile` produces one file that needs neither Node nor Bun, for a Homebrew or `curl | sh` install next to the npm package. Needs a second store adapter on `bun:sqlite` (the store is written for `node:sqlite`) behind the existing `StorageAdapter` port, and the CLI tests run against the binary. Measured 2026-11-03: `sati task list` takes 49 ms on Bun 1.4.4 against 77 ms on Node 26. Deferred: PLAN keeps Node as the runtime (users install with npm) and Node is within the cold-start budget; revisit with Phase 6 distribution.
- **Switch an existing project's mode** (`sati init --upgrade --mode git`): move a stealth project to git mode in place, keeping its records and id, and undo the stealth-only files (`CLAUDE.local.md`, the `.git/info/exclude` lines). Raised 2026-11-03 when moving a real repo from stealth to git mode, which today means moving the database aside, running a fresh `init` and recreating records by hand. Deferred: not in PLAN; rare once a team has adopted sati.
- **Bound agent-facing responses**: offer compact task summaries with a result budget and fetch details by ID. Preserve full records for existing integrations and exports. In the local review, projecting 22 tasks to short ID, title and status reduced compact JSON from 20,341 to 2,043 characters. Done for MCP `task_list` and `search` in Phase 7a (2026-11-07); context entries and a result budget remain ideas.
- **Avoid redundant agent turns**: the brief-once rule is done (Phase 5f). Still open: check for ready work before the idle Stop hook blocks. Compare model usage and task outcomes on matched solo, resumed and parallel tasks.
- **Scope `findBySuffix` to a project**: the storage port takes no project ID, so short-ID lookup reads up to 100 matches across all projects and filters afterwards. Add a `projectId` parameter to the port. Raised 2026-11-07 in the polish review.
- **Calendar export** (`sati calendar export`): an `.ics` of due dates and milestone targets. Moved out of Phase 7c on 2026-11-07 to keep sati lean: My work and the board already show what is due, and a read-only feed goes stale the moment a date moves.
- **Email and Telegram notifications**: beyond the Phase 7d in-app inbox. Moved out on 2026-11-07: each channel brings delivery, unsubscribe and secret handling that a memory tool does not need before people ask for it.
- **Attachments as links** (Drive, Figma, Canva) with a preview title. Moved out of Phase 7d on 2026-11-07: a note or task body already holds a link, and fetching previews means sati reaching out to other services.
- **Token ledger** (`sati stats tokens`): served, avoided by card reuse, hit rate. Moved out of Phase 8 on 2026-11-07: the Phase 8 gate measures savings with the agent tool's own usage report, and estimated numbers invite more trust than they deserve.
- **Khmer support**: bundle a Noto Sans Khmer subset (the CSP blocks web fonts, so the font named in the CSS loads only when the system has it), Khmer and English UI strings with `Intl` dates and numbers, `lang` set per note, and line-height for Khmer script. Moved out of Phase 5b and 7a on 2026-11-07 at the owner's request: not needed for the first release. Khmer search would also need a word splitter, since FTS5's `unicode61` breaks Khmer words apart.

The seven ideas from the 2026-11-07 review of [agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) moved to `PLAN.md` Phase 5c. Not taken from it: routing CI failures and review comments back to the owning agent (needs network access and GitHub tokens; revisit with hosted mode), and computing task status from facts instead of storing it (the snapshot and merge driver rely on a stored status).

Not fixed from the 2026-11-09 pre-cloud review (PLAN Phase 5e), each with the reason:

- **Longer minimum short handle**: `parseHandle` accepts a 4-character suffix and `findBySuffix` limits to 100 rows before the deleted filter, so a table with many deletions can hide a live match. Deferred with the existing "scope `findBySuffix` to a project" item; both change the storage port.
- **Session token in the browser-open argv**: `sati ui` passes the sign-in link to `open`/`xdg-open`, so another local user could read it with `ps` while the server runs. Accepted for a single-user machine; revisit with the hosted team server.
- **Order-independent conflict markers**: when two clones both merge the same text conflict, the markers come out in ours-then-theirs order, the two results differ with equal versions, and import treats the tie as unchanged. Deferred: needs two independent merges of the same conflict; the fix (order by content, or break ties on a hash) changes the file format.
- **Keep the dragged card mounted**: during an auto-scroll drag on the virtualised board the dragged card can leave the 8-row overscan and unmount. Not reproduced; revisit if a drag ever cancels.
- **Drop Tailwind and add type and spacing tokens**: the UI uses no Tailwind utilities, only its preflight, and has 13 font sizes with no scale. Deferred: removing preflight changes every page's base styles and needs a full visual pass.

Found by the 2026-11-10 whole-project review (PLAN Phase 5g) and left for the owner, each with the reason. These are now planned as PLAN Phase 5h; `docs/review-followups.md` has the plan and checklist for each. Nothing here was verified beyond a code read unless it says so.

Behaviour and data:

- **Refuse secrets in tasks, decisions and features at write time**: only notes, comments, cards and handoffs are checked on write; the rest are caught at export. A token in a task body then fails every later debounced export batch (the failed records are re-queued), and the only message is on the MCP server's stderr. Not done: a false positive would start blocking task writes; wants a decision on which fields to scan.
- **Import does not run before the pre-commit and MCP-start exports**: Phase 5g stops the export from overwriting a newer file, which closes the data loss. Running an import first would also load the teammate's edit; left because a refused import should probably block the commit, and that is a workflow change.
- **`effort: null` after a clear** stays in the file, and an older sati refuses the whole snapshot on any unknown key. Add `effort` to `EMPTY_FIELDS` and say "upgrade together" in the FAQ. Not done: `EMPTY_FIELDS` is frozen by design and changes the file format.
- **Lock refusal on a claimed task ignores status**: a task in `review` or `blocked` with a live claim still refuses another actor's tagged lock. Unsure whether that is wanted.
- **Undo skips the transition and link checks**: it writes the old value back as is.
- **Ready queue cap**: `readyTasks` reads 500 rows and filters effort and due date in memory, so matches past 500 are missed with no cursor.
- **`plan import` reads headings and checkboxes inside code fences** as milestones and tasks.
- **A unique-name clash on update** (renaming an actor) surfaces the raw SQLite error; only insert maps it to CONFLICT.
- **Merge driver output is not checked against limits**: two near-limit bodies with conflict markers pass 100 KB and the next import refuses the snapshot. Checklists merge whole, so two concurrent ticks keep one.
- **Symlinked record folder**: files are `lstat`ed, folders are not, so a committed `.sati/tasks` symlink makes export write record files outside `.sati/`.
- **Temp files**: a process killed between write and rename leaves `<id>.json.<pid>.tmp`, and pre-commit's `git add -A -- .sati` commits it.
- **Test store drift**: `MemoryStore` differs from `SqliteStore` (no `parentId` filter, no rank order, no 500 clamp, cursor on an unknown id, unique actor names). Core tests can pass on behaviour the real store lacks.
- **CLI tests write to the real project registry**: about 1,400 `sati-cli-*` temp entries on this machine, so `sati projects` takes 1.5 s. Tests need their own registry location; `projects` needs pruning.

Speed:

- **Lock scans in the write lock**: `acquireLock`, `releaseTaskLocks` and `renewTaskLocks` read every lock; a renewal writes one activity row per lock. Fine at today's sizes; wants a `taskId` filter in the storage port.
- **`context_get` with no path** returns every card with all facts, and the rules block tells agents to use it first. Cap it, or point the rule at `recall`.
- **Write tools echo the whole record** (body included) on every `task_update`. Return the changed fields.
- **`task_list` rows use full 30-character ids** where the brief uses handles.
- **Full export on every MCP start and commit** encodes every record. Compare size and mtime first.
- **Board**: default TanStack Query settings refetch the snapshot on every window focus and retry 3 times (about 7 s of "Loading…" when the server is gone); in a `general` project the board re-renders on every filter keystroke.

Agent and CLI use:

- **No `task_get`**: the workflow says "re-read it" after a stale token and no tool reads one task.
- **Unfenced text**: only the brief and `recall` fence teammate text as data; `task_claim`, `task_list detail:full`, `note_get`, `context_get` and `changes` return it plain, and the workflow says the brief fences it.
- **Rules block**: step 7 does not name the claim token, and the code block never names `recall`. Changing it means a PLAN edit and `init --upgrade` in every project.
- **MCP descriptions** omit `subtasks[]`, `format: "short"`, `maxTokens`, `leaseMinutes`; subtasks take no `effort`; six write tools have no annotations.
- **`task_create` always creates**, then says to cancel a duplicate; each cancelled duplicate stays in git.
- **`--label` on `task list` but `--labels` on create and update**, and each one's hint suggests the other spelling. `--feature`, `--parent` and `--depends` cannot be cleared with `none`.
- **`--body -` with empty stdin** creates a record with an empty body.
- **`sati review`** prints the guard count but not the findings, lists the latest 20 decisions whatever the range, and counts `.sati/` files.
- **`nudge` and `guard --hook` read stdin without the TTY check** `wait` has.
- **`openApi()` says version `0.0.0`** by hand.
- **Two `sati serve` starts can race** between the liveness check and `listen`.

Board:

- **Clicking outside a form dialog, or Esc, closes it with no dirty check**: a long note body is lost.
- **After Save in the task panel** the "changed while you were editing" banner can flash and focus drops to the page; there is no "Saved" toast. The feature paths form does the same.
- **A task deleted elsewhere** makes the open panel vanish, and the next click asks to discard edits nobody can see.
- **Settings**: the fieldset is disabled during a save, so the focused radio loses focus.
- **Copy failures say "That change did not save"**, and a copy refetches the snapshot.
- **"Approve latest"** has an `aria-label` that does not contain the visible text.
- **Wording**: "List", "Column" and "Status" name one thing; a toast says "todo" where the board says "To do"; the Effort select has no hint that it steers which model does the task.
- **Smaller**: checklist Remove has no undo; comment drafts on Notes and Decisions are lost on navigation; the palette keeps old hits while the text changes; "just now" never ticks; Changes links open the list, not the item; Markdown has no `*` lists or nested lists; Back after declining a discard adds history entries; the new-item highlight timer is not cleared.
- **Constants copied from core** (`PRIORITIES`, `MILESTONE_NEXT`, comment limits, kind words in three places). Export them or add a parity test.

Repo, docs and release:

- **PR #1 is stale**: built from 14 changesets for 0.0.1; `main` holds 56 for 0.1.0. Do not merge it as it stands; let the release workflow rebuild it once Actions runs.
- **56 changesets read badly as a first release**: many fix behaviour nobody ever installed. One "initial release" entry would be clearer.
- **Provenance needs a public repo**: `publishConfig.provenance` makes npm refuse a publish from a private one. Check before the first release.
- **Workflow actions are pinned to tags, not commits**, and the release job holds `NPM_TOKEN` and `id-token: write`. It also publishes on push to `main` without waiting for CI or a packed-install check.
- **CI cost**: 10 e2e shards on every push and PR, plus a nightly of 100 seeded runs.
- **The guard job in CI runs the PR's own build of sati**, so a PR can change the guard that checks it.
- **`docs/handoff.md` is out of date throughout** (licence, name, PR #2, line numbers); `AGENT_KICKOFF.md` still says the name is not chosen. Rewrite or delete.
- **PLAN drift**: the tech-stack table names TanStack Router, shadcn/Radix, cmdk, Tiptap, `@hono/zod-openapi` and pino, none used, with no ADR; "ten internal packages", `e2e/guard/`, CI benchmarks, bundle-size and licence checks, `sati migrate` and release channels are not built; two Phase 0 boxes and two open decisions are settled but unticked.
- **`docs/team-brain.md`** parity table describes the state before Phase 7a.
- **Small doc errors**: "every command takes `--json`" (six do not); the FAQ adds `rules sync` after `init --upgrade`, which already does it; "absolute path" for hooks where a project install records `node_modules/.bin/sati`; no dev-setup section (`playwright install chromium`, `pnpm local`).
- **Leftovers**: `packages/store-sqlite/scripts/fts-sql.py` is referenced nowhere; `dist/index.d.mts` (10 bytes) ships; the cli `package.json` has no `homepage`, `bugs` or `keywords`; `@types/node` is 22 in `e2e` and 24 at the root; the UI tsconfig does not extend the base. All fixed in review WP9 (2026-11-10).

Review coverage: `sync`, `mcp`, `ui`, the UI server and the repo files were read in full. In `core`, ten services were not read (`recall`, `brief`, `changes`, `shell-changes`, `guard`, `overlap`, `similar`, `workflow`, `template`, `doctor`). The CLI `--help` sweep was partial. No dead-code search ran (no knip config).

From the 2026-11-10 review (WP10), features rather than bugs:

- **`milestone update --date none`** to clear a target date, as `task update --due none` does.
- **CLI parity with MCP**: `task create --checklist`, similar tasks in `task create` output, `roadmap_upsert` `dryRun`, `brief --max-tokens`, `"me"` as an MCP assignee, listing deleted tasks and filtering by parent in `task list`.
- **A per-file removal ratio** in the guard, or a check for stub files, so replacing a protected file with one line is blocked like emptying it. Needs an owner decision on the threshold.
- **"Today" in the user's time zone**: due dates and `--since` count days in UTC. Using local time needs a time-zone setting per person, and teammates in different zones would then disagree on what is overdue; records synced through git need one shared clock. Kept as UTC for now (review WP10).
- **fff as an optional search companion** (evaluated 2026-11-11, at fff 0.11 with 0.12 announced): `sati init` could offer to add the `fff-mcp` server (github.com/dmtrKovalenko/fff, MIT) next to sati's MCP server, so agents find files with it and remember with sati. Worth trying without it: frecency and git-status ranking for `recall`. Rejected as a dependency: the npm package needs the `ffi-rs` native addon and prebuilt binaries, and sati matches exact globs from `git ls-files`, so fuzzy search has no use inside it. Needs a measured benefit over the agents' own Glob and Grep before any work.
