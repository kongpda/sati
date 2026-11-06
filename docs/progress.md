# Progress

## Phase 0 — Foundations

Status: **blocked on human steps** (gate not passed yet).

| Item | State |
| --- | --- |
| Monorepo (pnpm, Turborepo, strict tsconfig, Biome) | done |
| GitHub Actions CI (3 OS x Node 22/24) | done, not yet run (no GitHub remote) |
| Changesets + provenance publish workflow | done; npm scope, npm 2FA and `NPM_TOKEN` secret need a human |
| Product name + npm/domain check | open, needs a human |
| `AGENTS.md`, conventions, ADR template | done |

### Choices made on ambiguous items

- Package names use the placeholder `@kongpda/sati`; internal packages use the private `@sati/*` scope and are bundled into the CLI.
- Biome does not format or lint Markdown, so hand-written docs (`PLAN.md`) are not rewritten.
- TypeScript 7.0.2 is used. tsdown warns its declaration emit on TS 7 is experimental. If d.ts output breaks, pin TypeScript 5.x and record an ADR.
- `@types/node` is pinned to `^22` to match the lowest supported Node.

### Verify output (local, 2026-11-03, macOS, Node 26.12.1)

```
pnpm lint       Checked 19 files. No fixes applied.
pnpm typecheck  Tasks: 3 successful, 3 total
pnpm test       @sati/core 1 passed; @kongpda/sati 1 passed
sati --version 0.0.0   (from dist and from an npm-installed packed tarball)
changeset status: @kongpda/sati patch -> 0.0.1
```

### Decision 2026-11-03

Owner chose to keep the `sati` / `@kongpda/sati` placeholder for now. Name, npm scope and the publish gate are deferred.

### Gate remaining

On 2026-11-04, the release workflow generated the `0.0.1` branch but GitHub
Actions could not create its pull request. PR #1 was opened manually. Linux CI
passed on Node 22 and 24. Windows with Node 24 failed during dependency
installation when `node-gyp` could not find Visual Studio for `better-sqlite3`.
The public npm registry still returned 404, the GitHub repository secret list
was empty, and the local npm CLI had no authenticated user.

The gate is "`sati --version` publishes to npm as `0.0.1` from CI". It needs:

1. Final product name and npm scope (then edit `packages/core/src/name.ts` and the `@kongpda/sati` package name).
2. A GitHub repo with this code pushed.
3. npm account 2FA, and an `NPM_TOKEN` secret (or npm trusted publishing) on the repo.
4. Merge the "Version Packages" PR that the release workflow opens.

## Phase 1 — Core, SQLite and CLI

Status: **gate passed** (2026-11-03). Waiting for review before Phase 2.

### Choices made on ambiguous items

- Storage port is async (ADR 0001) so Postgres and remote adapters reuse the same services.
- One project per DB. `sati init` refuses to run twice (CONFLICT).
- Services cover what the checklist names: create / update / list for each entity, plus task
  ready and complete. Delete, claims and locks are not in Phase 1 (claims and locks are Phase 3).
- Tasks start only in `backlog` or `todo`. `done` is reached only through `complete`, which needs
  a summary and at least one file. Reopening a done task clears its completion.
- Removing a shipped or deprecated feature takes a `decisionId` whose Decision lists the feature.
- Decisions are append-only; a change is a new Decision with `supersedes`.
- A no-op update writes nothing and logs nothing.
- Activity diffs store `{from, to}` per changed field; strings over 200 characters are stored as
  their length only, to keep the log small.
- Core service tests use an in-memory adapter (`test/support/memory-store.ts`); the SQLite
  adapter has its own tests, and the CLI end-to-end tests run services on SQLite.
- Actor identity: `SATI_ACTOR` wins; otherwise an agent is `<tool>@<worktree>#<session8>` and a
  human is `<user>@<worktree>`. Only Claude Code detection (`CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`) is verified; other tools are picked up from the generic `AI_AGENT`
  variable, unverified for Codex, Cursor and Gemini CLI.
- CLI covers `task`, `feature`, `note`, `decision` and `search`. Milestone commands are not in
  the PLAN's CLI list, so there are none yet; milestones are reachable through `--milestone` ids.
- List flags are comma-separated (`--labels a,b`, `--files a.ts,b.ts`) because citty keeps only
  the last value of a repeated flag.
- No colour output in Phase 1 (so "colour only on a TTY" holds trivially).
- Bad usage (missing argument, unknown command, non-numeric number) exits 2 (`USAGE`), not
  citty's default 1. With `--json`, errors print `{"error":{code,message,hint,details}}` on stdout.
- The CLI bundles drizzle-orm, zod and ulid. Loading them as separate npm files took ~200 ms per
  command (over the 150 ms budget); bundled, `sati task list` takes ~80 ms. `sati --version`
  loads only the name constant (~30 ms).
- `sati init` picks git mode inside a repository and standalone outside one; standalone inside
  git (and git or stealth outside git) is rejected. It asks questions only on a TTY. Without a
  TTY it writes nothing unless `--yes` is given; with `--json` the error carries the preview.
- `sati init` only reports detected agent tools in Phase 1. Writing their configs, hooks and
  rules is Phase 2 work, so the preview lists just `.sati/sati.config.json` for now.
- A committed `.sati/sati.config.json` (as in a fresh clone) is kept, and its project id is
  reused for the new local DB.
- Core coverage is enforced: `pnpm test` in `packages/core` runs with v8 coverage and fails
  below 90% statements, branches, functions or lines. Current: 97.7% statements, 92.0%
  branches, 94.3% functions, 98.5% lines.
- `pnpm bench` (in `packages/cli/bench/bench.ts`) covers the three Phase 1 budgets: CLI cold
  start, CLI read p95 and full-text search on 50,000 records. It seeds 25,000 tasks and 25,000
  notes, then times 30 runs of `--version`, `task list`, `task list --ready` and `search`, and
  exits 1 if a budget is missed. Cold start is measured as p95 of a spawned process. The other
  budgets (claims, MCP, brief, guard, export, UI) belong to later phases. The "fail CI on a 20%
  regression" rule needs a stored baseline and CI wiring, so it is left for when CI runs benches.
- The first bench run missed the read budget (p95 202 ms). Lists sorted every task because the
  status index stopped at `rank`; indexes now end in `(rank, id)` (migration 0002).

### Verify output (local, 2026-11-03, macOS, Node 26.12.1)

```
$ pnpm typecheck && pnpm test && pnpm bench
 Tasks:    5 successful, 5 total
@sati/core:test:       Tests  70 passed (70)
@sati/core:test: All files      |   97.67 |    91.95 |   94.25 |   98.53 |
@sati/store-sqlite:test:       Tests  24 passed (24)
@kongpda/sati:test:       Tests  17 passed (17)
 Tasks:    6 successful, 6 total
@kongpda/sati:bench: Seeded 50000 records in 8178 ms.
@kongpda/sati:bench: PASS  CLI cold start (sati --version), p95               37.8 ms  (budget 80 ms)
@kongpda/sati:bench: PASS  CLI read command, p95                              122.0 ms  (budget 150 ms)
@kongpda/sati:bench: PASS  Full-text search on 50000 records, p95              31.0 ms  (budget 50 ms)
 Tasks:    4 successful, 4 total
```

In a temp git repo:

```
$ sati init --yes && sati task create "x" --json && sati task list --ready --json
Initialized "tmp-cssdvnffcf" in git mode.
  database  /private/var/folders/29/x0cgr_ld17l7y66k0qkdhl880000gn/T/tmp.CssdvnFFcf/.git/sati/sati.db
  created   .sati/sati.config.json
  tools     claude-code
Next: sati task create "First task"
{
  "id": "tsk_01M6G3F885WS0EXW63ARR0ANXE",
  "projectId": "prj_01M6G3F84C5G06X0W01D6YC8XZ",
  "createdAt": "2026-11-03T07:02:42.692Z",
  "updatedAt": "2026-11-03T07:02:42.692Z",
  "createdBy": "actr_01M6G3F855K2PGWFFT1N3N46WS",
  "version": 1,
  "deletedAt": null,
  "title": "x",
  "body": "",
  "status": "todo",
  "priority": "medium",
  "featureId": null,
  "parentId": null,
  "dependsOn": [],
  "labels": [],
  "branch": null,
  "worktree": null,
  "claim": null,
  "completion": null
}
[
  {
    "id": "tsk_01M6G3F885WS0EXW63ARR0ANXE",
    "projectId": "prj_01M6G3F84C5G06X0W01D6YC8XZ",
    "createdAt": "2026-11-03T07:02:42.692Z",
    "updatedAt": "2026-11-03T07:02:42.692Z",
    "createdBy": "actr_01M6G3F855K2PGWFFT1N3N46WS",
    "version": 1,
    "deletedAt": null,
    "title": "x",
    "body": "",
    "status": "todo",
    "priority": "medium",
    "featureId": null,
    "parentId": null,
    "dependsOn": [],
    "labels": [],
    "branch": null,
    "worktree": null,
    "claim": null,
    "completion": null
  }
]
exit: 0
```


## Phase 2 — MCP, brief and rules

Status: checklist done; gate waived for now (see "Gate remaining").

### Choices made on ambiguous items

- **MCP tool set.** PLAN lists 14 tools, but `lock_acquire`/`lock_release`, `context_get`/`context_put` and `feature_check` need the locks, context cache and guard services, which are Phase 3 checklist items. Phase 2 registers the tools whose services exist (`task_list`, `task_create`, `task_claim`, `task_update`, `task_complete`, `feature_upsert`, `decision_record`, `search`, plus `sati_brief`). The other five land in Phase 3 with their services. The Phase 2 gate (an agent finishes a real task with sati tools only) needs only the first set.
- **Basic claims now, leases with heartbeats and fencing later.** `task_claim` needs a claim, so core gains `claimTask`: one write transaction (`BEGIN IMMEDIATE` in SQLite) that fails with CONFLICT naming the holder while another actor's lease is live, moves the task from `todo` to `in_progress`, and logs a `claim` activity row. The lease length defaults to the project's `leaseMinutes`. Following "leases renew on any write by the holder", the holder's `task_update` renews the lease; moving a task back to `backlog`, `todo` or `cancelled` drops the claim so it shows up as ready again. Heartbeats, concurrency stress tests and fencing tokens remain Phase 3 items.
- **Tool results** are compact JSON (no indentation) to save agent context. Domain errors come back as tool errors carrying `{ error: { code, message, hint, details } }`, matching the CLI's `--json` errors. Schema errors caught by the SDK come back as its plain-text tool error.
- **Ids.** Tools accept full ids or short handles (`tsk_8f3k2a`); resources print short handles.
- **`sati mcp`** loads the MCP SDK lazily so other commands keep their cold-start budget. The SDK stays an external dependency of the CLI; workspace packages are bundled as before. The stdio transport does not report a client disconnect, so the server also stops when stdin ends.
- **The brief** (`sati brief`, `sati_brief`) is Markdown in four sections: your claimed tasks with their feature's acceptance criteria, ready tasks, decisions from the last 7 days, and protected features with their paths. Empty sections say so in one line (or are left out for decisions and protected features). `--format=short`, for resumed and compacted sessions, keeps only your tasks and the top three ready ones. Tokens are estimated as characters / 4; when the brief is over its cap (1,500, or a lower `maxTokens`), items are dropped from the bottom section up and a "… N more left out" line is added. Lines are clipped to 160 characters. The project has no description field, so the "what the project is" paragraph is its name, mode and the caller's identity.
- **Deferred from the brief:** clearing expired leases (the brief is a read; lease cleanup comes with the Phase 3 leases item), others' active locks and stale context entries (Phase 3 services), and "changes since my last session" (needs a per-actor session marker that the plan does not define yet).
- **Duplicate detection.** `task_create` searches before it creates (so the new task never matches itself) and returns the task plus `similar`: up to three existing tasks, best first. FTS finds candidates sharing any significant title word (3+ letters, minus a short list of words common in task titles such as "add", "fix", "update"); a candidate counts when the Dice overlap of significant title words is at least 0.5. Done tasks are kept, since redoing finished work is duplicate work too; cancelled ones are skipped. The task is still created: the agent decides, and the tool description tells it to cancel the new task if one match is the same work. Only the MCP tool reports matches; `sati task create` is unchanged.
- **Agent files.** `sati init` sets up the tools it detects (marker files, or the agent running it) plus any named with `--tools`. Every project gets the managed block in `AGENTS.md`. Claude Code gets `@AGENTS.md` in `CLAUDE.md` and a `sati` entry in `.mcp.json`; Codex gets `[mcp_servers.sati]` in `.codex/config.toml`; Cursor gets `.cursor/mcp.json` and `.cursor/rules/sati.mdc`; Gemini CLI gets `.gemini/settings.json` and a block in `GEMINI.md`. MCP configs are merged: other servers and keys are kept, a `sati` entry the user already wrote (say, one running through `npx`) is left alone, and a config that is not valid JSON stops init before anything is written. The MCP command is `sati mcp`, which assumes the CLI is on PATH.
- **Stealth mode** must leave `git status` clean, so it never edits files that already exist (they are reported as `skipped`), puts the rules block in `CLAUDE.local.md` instead of `AGENTS.md`/`CLAUDE.md`, and lists every file it creates in `.git/info/exclude`. Files listed there stay sati's to update.
- **The rules block is the plan's text word for word**, so it already names Phase 3 tools (`feature_check`, `lock_acquire`, `context_get`, `context_put`). Until Phase 3 lands, agents will not find those tools. The block is versioned (`v1`), and `sati rules sync` rewrites it.
- **Managed rules files.** Blocks go into `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md` and a single-file `.clinerules`. sati owns whole files at `.cursor/rules/sati.mdc` (`alwaysApply: true`), `.windsurf/rules/sati.md` (`trigger: always_on`), `.kiro/steering/sati.md` (`inclusion: always`) and `.clinerules/sati.md`; these still carry the markers, so drift checks can treat every file the same way. Any older `v<n>` block is replaced in place.
- **`sati rules sync`** reruns the same plan as init for the tools detected now (plus `--tools`), so it also adds missing MCP entries. It reports `create`/`update`/`keep`/`skip` per file and "Everything is up to date." when nothing changed. Drift reporting in `sati doctor` comes with the Phase 5 doctor item.
- **Claude Code hooks** go into `.claude/settings.json` (`.claude/settings.local.json` in stealth mode, which Claude Code treats as personal). SessionStart runs `sati brief --format=agent` on `startup|clear` and `sati brief --format=short` on `resume|compact`; Stop runs `sati nudge`. The merge keeps every other setting and hook, and adds a group only when its command is not already there, so a user can reorder or edit ours freely.
- **`sati nudge`** lists the tasks the caller holds a live claim on (`in_progress`, `review` or `blocked`). As a Stop hook (`hook_event_name: "Stop"` on stdin) it prints `{"decision":"block","reason":...}` so the agent completes or updates them, but only once: with `stop_hook_active` set it prints the reminder as plain text and lets the stop through. With no held tasks it prints nothing. Errors exit 1, not their usual code, because Claude Code reads exit 2 from a Stop hook as "block".
- **The skill** (`.claude/skills/sati/SKILL.md`) is the same workflow text the MCP server serves as `sati://workflow`, so the text now lives in core and both use it. The skill's description tells Claude Code when to load it.
- **Dogfood.** Phase 2 was tracked in sati itself: every checklist item was a sati task, claimed before work and completed with a summary and files. This repo now has the rules block in `AGENTS.md`, `@AGENTS.md` in `CLAUDE.md`, the MCP entry in `.mcp.json`, and the hooks and skill under `.claude/`, all written by `sati rules sync`.

### Verify output (local, 2026-11-03, macOS, Node 26.12.1)

```
$ pnpm lint && pnpm typecheck && pnpm test
 Tasks:    7 successful, 7 total
@sati/core:test:       Tests  83 passed (83)
@sati/core:test: All files      |   98.08 |    90.23 |   95.68 |   99.11 |
@sati/store-sqlite:test:       Tests  24 passed (24)
@sati/mcp:test:       Tests  10 passed (10)
@kongpda/sati:test:       Tests  36 passed (36)
 Tasks:    8 successful, 8 total
```

Brief size: the core test "stays under the token cap on a large project" checks the 1,500-token cap
on a large fixture. In this repo, `sati brief --json` reports 54 tokens (agent and short formats).

The Stop hook against this repo's DB while holding a claim:

```
$ echo '{"hook_event_name":"Stop","stop_hook_active":false}' | sati nudge
{"decision":"block","reason":"You still hold tsk_e25mwf (Claude Code hooks: SessionStart brief (startup, compact, resume) and Stop nudge). If the work is finished, call task_complete with a summary and the files touched; otherwise call task_update with its status and a note."}
```

### Gate remaining

- **Claude Code and Codex each finish a real task using only sati tools.** This needs a person to
  start fresh sessions in each tool, with `sati` on PATH, in a project set up by `sati init`. The
  automated MCP tests cover the same flow (brief, list, claim, update, complete) through a real
  client over the SDK's in-memory transport, but they are not the gate.
- **Waived 2026-11-03 by the user.** Phase 3 starts before these runs. The gate is still owed:
  run it once the Phase 3 tools exist, so the rules block no longer names missing tools.

### Fixes after the checklist

- `sati init` and `sati rules sync` warn on stderr when `sati` is not on PATH, because the MCP
  config and hooks start it by name and would otherwise fail without a message (for example after
  `npx ... init`). JSON output is unchanged.
- A `.claude/settings.json` whose `hooks` setting is malformed now stops with a VALIDATION error
  instead of crashing the merge.

## Phase 3 — Coordination

Status: in progress.

### Claims with leases and heartbeats

- The claim check-and-set already ran in one `BEGIN IMMEDIATE` transaction (Phase 1). New here: a
  test that starts 20 `sati task claim` processes on one task. Exactly one wins, 19 get CONFLICT
  (exit 4), and none see `SQLITE_BUSY`. With a deferred `BEGIN` the same test fails, so it guards
  the lock mode.
- Heartbeats: choice on an ambiguous item. "Any write by the holder" is read as any write the
  holder makes to the claimed task (update, or claiming again to renew). Writes to other records
  do not renew it. Lock writes can renew claims when locks land, if needed.
- Expired leases: `releaseExpiredClaims` clears them, as PLAN asks of every brief. It runs at the
  start of `buildBrief` and writes only when something expired. Choice: an expired `in_progress`
  task goes back to `todo`, so it shows up as ready again. `review` and `blocked` tasks keep their
  status and only lose the claim. Each release logs a new activity verb, `release`.
- `sati doctor` does not exist yet; it should call the same service when it is added.

### Path locks

- `sati lock acquire|release|list`, MCP `lock_acquire` and `lock_release`. The overlap check and
  the insert run in one write transaction. A test with 10 processes requesting overlapping paths
  shows exactly one gets the lock.
- Rules: an overlap with another actor's live lock fails with CONFLICT (exit 4), naming the
  holder, when either side is `exclusive`. `shared` over `shared` succeeds and returns the overlap
  as a warning. An actor's own locks never conflict. Default mode is `exclusive`.
- Overlap detection (choice on an ambiguous item): micromatch has no "can two globs match the
  same file" test, so paths are compared segment by segment after brace expansion. A literal
  segment must equal or match the other side's glob segment; `**`, or two globs in one segment,
  count as overlapping. A lock path also covers everything beneath what it matches, so `src`
  covers `src/a.ts`. This errs towards false overlaps (a refused lock or a warning), never a
  missed one. Results are cached per path pair in the process.
- Paths are normalised (`./src/` becomes `src`). Absolute paths and `..` are rejected, since they
  could never match a repo file and the lock would protect nothing.
- Release: the holder releases; anyone may release an expired lock; another agent needs `force`.
  A release is a soft delete with verb `release`, and the activity row names the actor who did it,
  which is how a forced release is logged. Expired locks are released by the next `lock_acquire`.
- `task_complete` releases the caller's locks tied to that task (`--task` / `taskId`) in the same
  transaction. Locks of other actors on the task are left alone; releasing them would be a force.
- The brief lists other agents' live locks in a "Locked by other agents" section (not in the
  short format). Locks do not renew task claims.
- `micromatch` 4.0.8 is a new dependency of core, as the stack names it. The CLI keeps it external
  (a runtime dependency) rather than bundling it.

### Guard

- `sati guard --staged` checks the staged diff (`git diff --cached --no-renames`, with removed
  line counts and the `HEAD` line count of each modified file). `sati guard --paths a,b` checks
  paths as edits. MCP `feature_check` takes paths and `modify` or `delete`. Exit 10 (BLOCKED)
  when anything is blocked; warnings exit 0.
- Rules, as in the PLAN: another actor's exclusive lock blocks (a shared one warns). Deleting a
  file of a shipped, protected feature blocks, and so does removing more than half of its lines
  (`guard.maxRemovalRatio` in `sati.config.json`). Any Decision listing the feature turns those
  into warnings that name the decision; the newest one wins. Any other change to a shipped
  feature warns. Features not shipped are ignored.
- Removal share (choice on an ambiguous item): removed lines over base lines across the
  feature's changed files, not the whole feature. Files with no counts (binary, or `--paths`) are
  left out. A deleted file counts as fully removed.
- Logging: staged mode writes one `guard` activity row per finding. `--paths`, the hook and
  `feature_check` are read-only, except that a blocked run let through by `SATI_GUARD=off`
  always writes its rows with `override: true` and the actor.
- Renames show as a delete plus an add, which errs towards blocking, until the rename item.
- `sati init` installs `.git/hooks/pre-commit` (found with `git rev-parse --git-path hooks`) in
  git and stealth modes. It runs `sati guard --staged` if `sati` is on PATH, and otherwise
  warns and lets the commit through. An existing hook is never overwritten: it is reported as
  `keep` if it already runs the guard and `skip` otherwise. Chaining with husky or lefthook is a
  later item.
- The Claude Code hook is `PreToolUse` on `Edit|MultiEdit|Write|NotebookEdit`, running
  `sati guard --hook`, which reads the tool input from stdin. Blocked exits 2 with the reason
  on stderr, so Claude Code stops the edit and shows the reason. Warnings go to stdout as
  `hookSpecificOutput.additionalContext` (assumed from the hook docs; not checked against a live
  Claude Code). Errors exit 1 so a broken sati never blocks edits. Paths outside the repo pass.
- `init` used to write the config JSON into every created file before the agent files replaced
  it. It now writes only the config entry.

### Export / import

- New package `packages/sync` (`@sati/sync`, bundled into the CLI like the others). It holds
  the file I/O, so `core` stays free of I/O: core only has `snapshotRecords` and
  `importRecords`. This grew the item by one package.
- Export writes `.sati/<plural>/<id>.json` for milestones, features, tasks, decisions, notes
  and context, soft-deleted records included as tombstones. Keys are sorted at every depth,
  2-space indent, trailing newline. A file is rewritten only when its content changed, through a
  temp file and a rename. Files with no DB record are left alone: they may be a teammate's
  records not imported yet.
- Import reads every file first. A file that does not parse, is over 1 MB, has a name that does
  not match its `id`, fails the schema, or belongs to another project rejects the whole import
  with VALIDATION naming the file; nothing is written. Otherwise one transaction inserts unknown
  records and replaces a stored one only when the file has a higher `version`, or the same
  `version` with a later `updatedAt` (choice on an ambiguous item). Each import writes an
  `import` activity row.
- `sati sync export|import` work only in git mode. Stealth and standalone commit nothing, so
  they exit with USAGE.
- Debounce: `sati mcp` in git mode exports 2 s after the last write, and once more on
  shutdown. CLI write commands do not export; the pre-commit hook covers commits. Export errors
  go to stderr and never fail the write.
- Hooks: `sati init` writes `pre-commit` (guard, then `sati sync export` and
  `git add -A -- .sati`) and `post-merge`, `post-checkout`, `post-rewrite`
  (`sati sync import`) in git mode. Stealth gets the guard-only pre-commit. A hook carrying the
  "Installed by `sati init`" header is ours and is updated; any other existing hook is skipped.
  Every hook warns and exits 0 when `sati` is not on PATH.
- Caveat: `git add` inside pre-commit also stages `.sati/` on a partial commit
  (`git commit <path>`). That is the intended snapshot, but it is a side effect worth knowing.

### Merge driver

- `sati merge-driver %O %A %B` merges one `.sati/` record file and writes the result over
  `%A`. It only parses JSON; nothing in the files runs. A side that is not a JSON object exits 1,
  which leaves git's normal conflict. A missing or empty base (both sides added the file) merges
  with an empty base.
- Per field: a field changed on one side takes that side. When both changed it:
  - Markdown fields (`body`, `description`, `context`, `decision`, `consequences`) get a
    line-level three-way merge (hand-written diff3, no new dependency). A clash keeps both
    versions between `<<<<<<< ours` / `=======` / `>>>>>>> theirs` markers inside the string.
  - Every list of strings or numbers is a three-way set merge: additions on either side stay,
    removals on either side stick. The result is sorted, so it does not depend on the side
    (choice on an ambiguous item: PLAN says "arrays union", but a plain union would undo
    removals).
  - Anything else takes the side with the newer `updatedAt`; a tie is broken by comparing the
    JSON values, so the merge stays symmetric.
- The merged record gets `version` one past both sides and the later `updatedAt`, so
  `sync import` on either clone takes it over the DB copy.
- `needsReview: true` is a new optional field on every entity (stored in the JSON data column,
  no migration). It is set on a Markdown clash and kept once set. Nothing clears it yet.
  The merge never fails on a body clash.
- Delete vs edit: `deletedAt` follows the one-side rule, so a delete on one side and an edit of
  other fields on the other gives a deleted record with the edits. Reviving is a later item.
- Bodies over 4M LCS cells (about 2000 x 2000 lines) are not diffed: a two-sided change of
  such a body is one conflict chunk. This bounds time and memory.
- `sati init` in git mode appends `.sati/**/*.json merge=sati` to `.gitattributes` (other
  lines kept) and sets `merge.sati.name` / `merge.sati.driver` in the local git config. The
  driver is found by name on PATH; recording an absolute path is the later security item.
- Property tests (fast-check, 2000 runs each): merge is deterministic; it is symmetric when no
  field clashes; no one-sided change or added label is lost; separate line edits merge cleanly.
  An end-to-end test merges two branches through git and the post-merge import.
- Found while testing: a commit that changes only records (`git commit -a` with no tracked
  file changed) stops with "nothing to commit". git decides that before the pre-commit hook
  stages the snapshot. Commits that also change code are fine. Workaround: `sati sync export`
  and `git add .sati` first. Not fixed in this item.

### Context cache

- `sati context put <path> --summary … [--key-files …]` and `sati context get [path]`, plus
  the MCP tools `context_get` and `context_put`. That makes 14 MCP tools, as PLAN lists.
- One entry per path: putting the same path again updates that entry (version bump, `update`
  activity row) instead of adding a second one. Paths are normalised like lock paths
  (`./src/` becomes `src`); `..` and absolute paths are rejected.
- The hash covers the tracked files the path covers: what it matches as a glob, or everything
  beneath it as a directory. Each covered file contributes `<blob id> <path>` from
  `git ls-files -s`, sorted, then SHA-256. No file is read and no content is stored.
  `gitCommit` records HEAD at put time (null before the first commit).
- `context_get` recomputes the hash on every call and returns `stale: true | false`. The git
  index comes in through a new optional `repo` port on `ServiceContext`, so core does no I/O;
  the CLI runtime supplies it in git and stealth mode.
- Choices on ambiguous items:
  - Standalone mode has no git, so the hash is empty and `stale` is `null` ("unknown"), never
    reported as fresh.
  - `git ls-files -s` sees only staged content. An entry goes stale once its changed files are
    staged or committed, not on unstaged edits, and untracked files are ignored.
  - `keyFiles` are stored for the reader only; they are not part of the hash.
- The brief gains a "Stale context" section (agent format only, ranked above protected
  features, trimmed first after them when over the token cap). It lists only stale entries.

### Secret scanner on export

- `exportSnapshot` scans every string field of every record (nested arrays and objects too,
  tombstones included) before it writes anything. One hit refuses the whole export with
  `VALIDATION` (exit 5); no file is written. The message lists entity, id, field and kind, at
  most 10 lines plus a count; it never contains the secret.
- Patterns: PEM private-key headers, AWS `AKIA`/`ASIA` keys, GitHub `gh?_` and `github_pat_`,
  Slack `xox?-`, `sk-` keys, Stripe live keys, Google `AIza` keys, JWTs, and `.env`-style lines.
- `.env` lines count only with an upper-case name containing SECRET, PASSWORD, PASSWD, TOKEN,
  CREDENTIAL, or ending in `KEY`/`_KEY`, and a value of 8+ characters that is not a reference
  (`$VAR`, `${VAR}`, `<...>`) or one repeated character. Lower-case names (code in a note) pass.
- The pre-commit hook needs no change: a failed export exits non-zero, which blocks the commit.
  The MCP debounced export already prints export errors on stderr and keeps serving.
- No allowlist or override flag: the plan asks for none. A false positive is fixed by
  rewording the field. If that proves too strict, an allowlist is an idea for `docs/ideas.md`.
- The scanner lives in `@sati/sync` (pure functions, `secrets.ts`); only export uses it.

### Fencing tokens (review fix 2)

- The token is the task version the claim writes (`before.version + 1`). Versions only grow, so
  a token is unique per claim and never reissued. A holder's lease renewal keeps the token.
- `Claim.token` is optional so claims stored before this change still parse. A legacy claim
  without a token accepts writes without one until it is released or re-claimed.
- Rule (`checkToken` in `services/task.ts`): every `updateTask` and `completeTask` on a claimed
  task must present the current claim's token; a missing or stale token, or a token sent for a
  task with no claim, fails with CONFLICT. This applies to every actor, not only the holder.
  Fencing is not authorization: any actor can read the token from `task show`.
- CLI: each call is a new process and cannot remember a token, so `task update|complete`
  without `--token` uses the claim's token when the caller holds the claim. `--token` overrides
  it. `task claim` prints the token. MCP stays explicit: agents pass `claim.token`.
- The workflow text tells agents to pass the token and to stop on a stale one. The rules block
  is unchanged, so its version was not bumped.
- Tests: the core fake-clock test covers the point of fencing (A's lease expires, B claims, A's
  late update and complete are refused). The CLI test cannot cover expiry: the CLI has no clock
  override. It covers the holder's implicit token, another actor, and a stale `--token`.
- Cleanup flagged: seven core hints and one doc comment still say literal `sati` instead of
  `CLI_NAME` (`grep -rn '`sati ' packages/core/src`). Left alone; the new hints use `CLI_NAME`.

### Rename to sati

The product, binary, packages, `.sati/` folder, DB paths, `SATI_*` env vars and MCP names were
renamed from the placeholder `brain` in one change; see `docs/decisions/0002-rename-to-sati.md`.
Docs were rewritten by search-and-replace, so earlier entries in this file use the new names
for work done under the old ones. The project record in this repo's DB is still named
"Agent Brain": there is no command to rename a project.

### Hook installer: absolute path, chaining, `--upgrade` (review fix 5)

Phase-order exception: the owner asked to install sati in another repo (khevents-inertia, which
has uncommitted work and a tracked `.claude/settings.local.json`). Git mode there needed these
Phase 3 items and Phase 3b known bugs first, so they were pulled forward before the Phase 3
gate. Stealth mode was installed there first; it needed none of this.

- Layout: the hook logic lives in runners at `<git-common-dir>/sati/hooks/<name>`, next to the
  DB. Only the runners and `merge.sati.driver` in `.git/config` hold the binary's path, and
  neither is committed, so a repo cannot change which binary runs.
- The path is `process.argv[1]` of the `sati init` that wrote it, resolved but not realpath'd,
  so a symlink such as `~/.local/bin/sati` survives rebuilds. A script without the exec bit
  is run with the current `node`. A runner whose binary is gone prints a hint to run
  `sati init --upgrade` and exits 0: a moved install never blocks commits.
- Each hook git calls gets a short marked block (`# >>> sati` … `# <<< sati`) that calls its
  runner if it is executable. The block goes right after the shebang, so it runs before the
  rest of the hook; a later `init` replaces the block in place. Only the pre-commit block stops
  git on failure. The block has no machine path, so it is safe in a committed husky hook, and
  it does nothing on a teammate's machine without sati.
- Where the block goes: the folder `git rev-parse --git-path hooks` names (follows
  `core.hooksPath`); for husky 9 (`core.hooksPath = .husky/_`, which husky regenerates) the
  user's `.husky/<name>` instead. With a lefthook config, `.git/hooks` belongs to lefthook, so
  sati writes `lefthook-local.yml` (create only; an existing foreign one is skipped and the
  snippet printed) and asks the user to run `lefthook install`.
- A whole hook file written by an older `sati init` (has the `Installed by` line, no block) is
  replaced by the block. Stealth mode never edits a hook file inside the working tree (husky,
  a tracked `core.hooksPath`) or `lefthook-local.yml`; it skips them with a note.
- The runners call sati through a shell function, so `exec` is gone: `exec` cannot run a
  function, and in a chained hook it would skip the user's own lines.
- `sati init --upgrade`: on an initialized project, plans and applies only `.gitattributes`
  (git mode), the runners, the chain blocks and the merge driver. Agent files stay with
  `sati rules sync`. Asks to confirm on a TTY; needs `--yes` otherwise. A plain second
  `sati init` still fails with CONFLICT, now with a hint to use `--upgrade`. Standalone has no
  hooks, so `--upgrade` there is a usage error.
- `.gitattributes` gets `linguist-generated`; the older line without it is replaced in place.

### Fix: hook hint and JSON indent (2026-11-03)

Found while moving a real repo from stealth to git mode.

- The runner's missing-binary hint held backticks inside double quotes, so `sh` ran `` `sati init --upgrade` `` instead of printing it. The hint is now single-quoted; a test runs a runner whose binary is gone and checks the exact message.
- Merging into `.mcp.json`, `.cursor/mcp.json` and `.claude/settings.json` rewrote them with 2-space indent, turning one added entry into a whole-file diff. The merge now keeps the file's own indent (2 spaces for a new file).

### Fix: record-only `git commit -a`

- `execute` in `packages/cli/src/runtime.ts` wraps the store in git mode with the same
  `afterWrites` the MCP server uses, and flushes it when the command ends: any command that
  wrote exports `.sati/` before exiting. A failed export (a secret) prints a warning and the
  error, and the write stands, as in MCP. Commands that write nothing export nothing.
- `sati sync import` does not export: after checking out an older branch the DB keeps newer
  records, and exporting them would leave the tree dirty after a plain checkout.
- The merge driver test now commits with `git commit -a`, and a new test commits a record-only
  change that way. Both fail with the export disabled (checked by hand).

### Fix: full-index scan on every update (schema v4)

The new claim benchmark failed with `SQLITE_BUSY` at 50,000 records. Cause: the FTS update and
delete triggers ran `DELETE FROM search_fts WHERE id = OLD.id`, and `id` is an UNINDEXED FTS
column, so every task, feature, note or decision update scanned the whole index (1 to 2.6 seconds
at 50,000 records) while holding the write lock. Other writers then waited past `busy_timeout`.

Migration `0003_fts_rowids.sql` adds `search_rowids` (record id to FTS rowid), backfills it from
the existing index and recreates the triggers to delete by rowid. Tests cover edits, hard deletes
and an upgrade from schema v3. A test without the backfill fails.

### Benchmarks (local, 2026-11-03, macOS, Node 26.12.1)

`pnpm bench` now also measures `task_claim` with 10 worker processes, each with its own connection
and actor, claiming 50 tasks at once on the 50,000-record DB:

```
Seeded 50000 records in 11570 ms.
PASS  CLI cold start (sati --version), p95               61.9 ms  (budget 80 ms)
PASS  CLI read command, p95                              139.2 ms  (budget 150 ms)
PASS  Full-text search on 50000 records, p95              32.4 ms  (budget 50 ms)
PASS  task_claim under 10 concurrent agents, p95           3.3 ms  (budget 50 ms)
```

The CLI read p95 is close to its budget and varies with machine load (one run on a busy machine
measured 233 ms on a tiny DB). Watch it in CI.

### Hybrid logical clock and delete-vs-edit (review fixes 3 and 4)

- A stamp is `wall#counter#node`. `updateWithLog` and `insertWithLog` stamp each field they
  change and store the latest stamp on the actor (`lastHlc`) inside the same transaction, with
  no activity row: it is bookkeeping so the next write still orders after a slow wall clock.
  Records written before stamps have no `stamps` map.
- The merge driver uses a field's stamps when both sides have one, and `updatedAt` otherwise.
  `lastHlc` merges by taking the greater stamp.
- A delete on one side and an edit on the other: the edit wins only when it is strictly newer,
  and then `deletedAt` is cleared and `needsReview` is set. A tie keeps the delete.

### Guard renames, empty globs, Bash, pre-push (review fixes 6, 7, 8 and 1)

- `git diff -M` reports a rename as one change with `from`. A rename is not a delete. When the
  new path leaves a shipped feature, the guard warns and prints `sati feature update <id> --paths`.
  No prompt: the hook has nobody to ask.
- Feature globs that match no tracked file are a brief section. Standalone mode has no file
  list, so it skips the check. An empty `paths` list is not flagged. `sati doctor` still owns
  the same check in Phase 5.
- `PreToolUse` also matches Bash. `rm`, `git rm` and `mv` become delete or rename changes,
  including flags, quotes and `&&` chains. Any other command is allowed. `sati rules sync`
  adds the Bash matcher to an existing settings file because groups are matched by matcher,
  not only by command.
- Git mode and stealth mode install a `pre-push` hook that runs `sati guard --range
  origin/main...HEAD`. A clone with no `origin/main` skips the check and still pushes.
  `.github/workflows/ci.yml` runs the same command. Claude settings gain deny rules
  `Bash(git commit --no-verify:*)` and `Bash(git commit -n:*)`, keeping any deny list already there.

### Core hints use the product-name constant

The seven core hints and the init/list hints that named the binary now use `CLI_NAME`.
The comment on the guard error code is documentation, not a hint, and was left as written.

### Local web UI (Phase 4, started before the Phase 3 gate)

The owner asked for the board before the Phase 3 gate. `sati ui` binds `127.0.0.1`, exchanges a
one-time token for an `HttpOnly` `SameSite=Strict` cookie, and refuses another Host or Origin.
CSP is `default-src 'self'` with no inline script. The built UI is `packages/ui/dist` (JS about
93 KB gzipped). A Vitest request covers 401, 403, the cookie, CSP and a snapshot. Dragging a
card updates status optimistically and rolls back with a toast. Done is not a drag target:
completion still needs `sati task complete`. A card, note or feature with `needsReview` has a
"mark reviewed" control that clears the flag. The roadmap page is a date timeline. Notes are a
Markdown field with a preview and backlinks, not a Tiptap editor. Mermaid stays a code block
until the `pele` licence is checked. Playwright, axe, and the 2,000-card frame budget are not done.

### Work loop, daemon and Phase 5 commands (2026-11-04)

- `review` defaults to `agents`. An agent `task_complete` lands in `review`; a human complete
  still lands in `done`. Send-back to `todo` requires `--reason`, stored on `reviewNote` and
  fenced as data in the brief. `review: none` is the old complete-to-done path.
- Project and actor updates do not get HLC stamps. Those records have no `stamps` field.
- `sati next` and `task_claim` with no id call `claimNext`: one write, highest priority, then
  oldest id. `autoContinue` is off until `sati settings --auto-continue`. The Stop nudge then
  tells an agent with no claim to run `sati next`.
- Outside a git repo, a TTY prompt (or `SATI_YES=1`) creates one standalone workspace at
  `~/.sati/personal` and records it in `~/.sati/projects.json`. `--project <slug>` selects a
  known project. `sati projects` counts ready, in-progress and review tasks.
- A network or bind-mount filesystem refuses a direct SQLite open and tells you to run
  `sati serve`. The daemon owns the file and other processes talk over `sati.sock`. It does
  not spawn itself.
- `pnpm test:e2e` runs a single-process claim loop (`packages/core/test/loop.test.ts`, 200
  steps, 4 actors). It is not the 4-worktree, 1,000-step, 100-repeat gate. That box stays open.
- Docs site, importer fuzz, Playwright, axe, `pele`, hosted Postgres and the owner items
  (name, npm two-factor, licence, three-project week) stay open.
- Biome ignores `.sati/`. Those JSON files are written by sati, and formatting them by hand
  would rewrite the project memory.

### Phase 3 E2E scenario and CI fixes (2026-11-07)

- `packages/cli/test/e2e.test.ts` runs the Phase 3 scenario. A real `sati init` sets up hooks,
  the merge driver and `.gitattributes`. Four agents in four worktrees then act at once, one
  process each, for N steps: create, claim, complete, lock, release and edit a shared task. A
  seeded generator (mulberry32) picks the ops. Between rounds, one agent may commit and merge
  (main pulls a branch, or a branch pulls main). Git ops run one at a time between rounds,
  since git serializes ref updates anyway.
- Each round is checked against the state at its start. Either outcome is allowed only where
  two ops of that round raced on the same record (a release and an acquire, say). A claim or
  lock must not win twice in one round. A refusal is wrong when nobody else held the record.
  At the end, every created task must be in main's tree, and the database must agree with what
  each agent was told.
- Mutation check: with the claim conflict check disabled, the scenario fails at step 4.
- `pnpm test:e2e [--repeat N] [--seed S] [--steps N]` (`scripts/e2e.mjs`) runs the agent loop
  once, then the scenario once per seed. One 1,000-step run takes about 90 s on an M-series Mac.
  The normal suite runs a 40-step version.
- CI: the `e2e` job replaces `worktree-stress`. It has 10 shards. Pushes and PRs run one seed
  per shard (10 runs). The nightly schedule and `workflow_dispatch` run ten seeds per shard
  (100 runs, about 150 runner-minutes). `workflow_dispatch` and `schedule` only work once this
  workflow is on `main`. So the Gate box stays open until a 100-run job passes there.
- The `SATI_WORKTREE_STRESS` mode of `concurrency.test.ts` is no longer run in CI. The new
  scenario covers it. It stays for local use; remove it if nobody needs it.
- PLAN's Verify line names guard fixtures in `e2e/guard/`. There is no such folder. Blocking a
  staged protected deletion is covered by `packages/cli/test/hooks.test.ts`, and the CI `guard`
  job checks `--range`.
- better-sqlite3 13 ships N-API prebuilds for Linux, macOS and Windows (x64 and arm64). It is now
  in `ignoredBuiltDependencies`, so pnpm does not run node-gyp. node-gyp needs Visual Studio on
  Windows, which broke the Windows CI jobs. Risk: plain `npm install` still runs node-gyp for any
  package with a `binding.gyp`. So `npm i -g @kongpda/sati` on Windows without build tools may
  fail. Check this before the first publish.
- The 501-lock paging test takes about 1 s locally. It timed out at 5 s on a loaded runner, so
  it now has 30 s.
- Bug found by the first CI run (seeds 41 and 51): after a merge, a done task got its old claim
  back. The branch held the claimed snapshot. Main had completed the task, which put `claim`
  back to its base value (`null`). The merge driver read "equal to base" as "unchanged" and kept
  the stale claim, so the next edit was refused. Fix: for plain fields, when both sides carry a
  stamp, the later stamp wins even if its value matches the base. Text and list fields still
  merge three-way. Covered by a unit test in `packages/sync/test/merge.test.ts`; both seeds pass
  at 1,000 steps.
