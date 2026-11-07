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

Status: **gate passed** (2026-11-07).

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
- Gate result (2026-11-07): the first `workflow_dispatch` run on `main`
  (https://github.com/kongpda/sati/actions/runs/42281216347) passed all 10 e2e shards, 100 seeded
  runs in all. Blocking a staged protected deletion is covered by `hooks.test.ts`; the CI `guard`
  job catches a `--no-verify` commit on push and pull request. That run's `guard` job failed
  because scheduled and manual runs have no change range (`git restore --source=''`). The job now
  runs only on push and pull request.
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

### Mermaid diagrams with pele (2026-11-07)

- `pele` 1.9.1 is MIT licensed and has no runtime dependencies, so the licence blocker is
  cleared. 1.9.1 is the newest release that is at least two weeks old.
- A fenced `mermaid` block in a note, decision or task body renders as SVG
  (`packages/ui/src/mermaid.tsx`). `markdown.tsx` now splits the source by fences first, so a
  code block keeps its blank lines and an unclosed fence still shows its text.
- pele loads through a dynamic `import("pele/lazy")` behind `React.lazy`. The entry chunk stays
  at 93.9 KB gzip, and pele's parser is only in the lazy chunk.
- The UI CSP has `style-src 'self'`. pele writes `style` attributes, and Chrome blocks them at
  parse time, even in a `DOMParser` document. So each `style="` inside a tag is renamed to
  `data-pele-style` before parsing and then set through CSSOM, which the CSP allows. Checked in
  Chrome: no `securitypolicyviolation` events, and the diagram picks up the theme.
- The `--pele-*` variables map to the UI tokens in `.mermaid` (`styles.css`), so dark mode
  follows. A parse error shows inline with the source, as a `role="alert"` caption.

### Windows CI paths (2026-11-07)

- `locateDb` returned git's `--show-toplevel` as printed, which uses `/` on Windows. It now
  passes through `resolve()`, so `root` is a native path like every other path in the CLI.
- Test temp folders use `realpathSync.native`. On Windows it expands 8.3 short names such as
  `RUNNER~1`, which git also expands, so paths compare equal.
- The sync test now expects `tasks/tsk_bad.json`, since snapshot paths use `/` on every OS.

### Phase 4 UI tests and gate (2026-11-07)

- Playwright 1.64.1 and `@axe-core/playwright` 4.14.0 live in the private `e2e` workspace
  package. axe-core is MPL-2.0; it is a dev dependency only and is never bundled or published.
- `pnpm test:ui` runs 23 tests against a real `sati ui --no-open` in a temp git repo: sign-in,
  create, edit, filter, bulk move, the command palette, Mermaid notes, navigation, an axe audit
  of every page on desktop and phone, and the performance gate. CI runs them in the `ui` job.
- Gate results on an M-series Mac, Chromium: a 2,000-card board loads its first card in a median
  of about 113 ms; scrolling holds 60 fps with a worst frame of 16.8 ms and no long frames; axe
  reports zero violations of any impact (WCAG 2.2 AA tags and best practice).
- Accessibility audit: the axe part is done and is in CI. The manual screen-reader pass is still
  open and needs a person, so that PLAN item stays unticked.
- Bugs the tests found, all fixed:
  - `sati ui --no-open` opened a browser. citty reads `--no-open` as `open: false`, but the flag
    was declared as `no-open`. It is now `open` with a default of `true`.
  - Stopping the UI server hung while an SSE stream or keep-alive socket was open. `close()` now
    also calls `closeAllConnections()`.
  - A plain click on a card did not open it, because the drag sensor took the pointer. A drag now
    starts only after the pointer moves 6 px.
  - A refused bulk move restored a stale snapshot of the whole board, so a card could stay in the
    wrong column. Rollback is now per task.
  - Virtualisation did not work: the board had no bounded height, so all 2,000 cards rendered.
    The layout now uses `minmax(0, 1fr)` rows and `min-height: 0`.
  - axe flagged no main landmark, no `h1` and skipped heading levels. Fixed with `<main>`, a
    visually hidden `h1` on the board and `h2` row titles.

## Project install (2026-11-07)

- The owner chose a per-project install over self-hosting for now: `npm install -D @kongpda/sati`,
  then `npx sati init`. Phase 6 (hosted mode) is deferred to v2; the owner also waived the Phase 5
  gate (the 3-project trial week stays open).
- A run is a project install when the running script resolves inside `<root>/node_modules` and
  `<root>/node_modules/.bin/sati` exists. This covers npm symlinks and pnpm's store layout.
- Agent configs then start `node_modules/.bin/sati`, relative to the project root, chosen over
  `npx --no-install sati` because npx adds a few hundred ms to every guard hook. This assumes each
  agent tool starts its project MCP servers from the project root, as Claude Code does.
- Claude Code hooks use `"$CLAUDE_PROJECT_DIR"/node_modules/.bin/sati`, because hooks run in the
  session's current folder, which moves when the agent runs `cd`.
- Git hooks and the merge driver record the absolute `.bin` link, not the versioned file inside
  the package, so they keep working after the dependency is upgraded.
- Moving between a global and a project install replaces the entries init wrote (exact command
  and `["mcp"]` args); an entry with any other command or extra keys is the user's and is kept.
- Teammates: nothing runs on `npm install` (no `prepare` script). The NOT_INITIALIZED hint says
  `npx sati init` for a project install, and `doctor` now checks the hook runner under the git
  common dir and the binary it starts, instead of `.git/hooks/pre-commit`, which missed worktrees
  and husky.
- `init` in a git-mode clone with a committed config now imports the `.sati/` snapshot, so a
  teammate does not need a separate `sync import`. Only git mode with a kept config imports;
  a first init has nothing to load. If the snapshot is invalid, init has already set up the
  project, so the error says to fix the files and run `sync import`.

## Review and polish pass (2026-11-07)

- A full review found about 50 issues across core, store, sync, cli, mcp and the UI. The high and
  medium ones are fixed, each with a test that fails when its fix is reverted.
- Ambiguous items and the choices made:
  - Undo of a field the activity log shortened to `<N chars>` is refused with a hint. Storing full
    values would grow every activity row.
  - Guarded features are `shipped` ones only, per PLAN. The brief now lists only shipped protected
    features, so planned or building protected features no longer appear there.
  - `doctor` exits 5 (VALIDATION) when a check fails; no exit code was documented before.
  - `export --all` stays as a declared no-op, because the guide still mentions it.
  - Readiness with a cancelled or deleted dependency is unchanged (PLAN line 134 requires `done`);
    logged in `docs/ideas.md` for the owner.
- Deferred: Windows paths in guard, a `--no-verify` deny-list, UI token rotation, project registry
  slug collisions, a guard hook pre-filter, lefthook-local overwrite, `findBySuffix` project
  scoping, card memoisation, routing 404s, and tests for the new markdown and shortcut behaviour.
## Deep review and fixes (2026-11-07)

The owner asked for a full review, bug fixes and a plan for non-developer users. Three review
passes covered core and store, CLI, sync and MCP, and the UI. Each fix below has a regression
test that fails on the old code. The open bugs and the team plan are PLAN Phase 5b and Phase 7;
the reasoning is in `docs/team-brain.md`. Rebased onto the polish pass (`d42377f`): where both
fixed the same bug (undo of shortened text, subtask cycles, 400 for bad JSON, the
`--no-auto-continue` flag) the polish pass's version is kept.

- **Test isolation.** In an orb whose `~/.gitconfig` sets `core.hooksPath`, `pnpm test` chained
  sati hooks into that global folder and 6 tests failed. `packages/cli/vitest.config.ts` and the
  Playwright harness now set `GIT_CONFIG_GLOBAL` to the null device and `GIT_CONFIG_NOSYSTEM=1`,
  with a git identity from the environment.
- **Undo.** On top of the refusal of shortened text, undo now refuses claim, release, complete
  and lock activities, and a task another actor holds, because replaying them skips the fencing
  and overlap checks.
- **Bash guard.** `parseShellChanges` now resolves the command word's basename, strips subshell
  parentheses, follows `cd`/`pushd` (an unknown target such as `cd -` resets to the start
  folder), reads `git mv`, `git -C`, `mv -t`, `unlink` and `sh -c`, and skips `git rm --cached`.
  The hook treats a move out of the repo as a delete. `hookBypass` blocks `--no-verify`, `-n` in
  a `git commit` short-flag group (stopping at a value flag such as `-m`, so `-mnew` passes) and
  `-c core.hooksPath=`; `git push -n` is a dry run and passes. `SATI_GUARD=off` still overrides.
- **Merge.** `needsReview` merges three-way: a side that cleared it after review wins over a side
  that left it, unless the merge itself conflicts.
- **UI server.** Writes made through the server bump an in-process counter added to
  `PRAGMA data_version`, so `/events` fires for them. Checked in Chrome with two sessions: the
  second tab showed a status change made in the first within 1.5 s.
- **UI.** A task in review can be moved to done by a person, on the board and in the panel (the
  server already allowed it). Chords with Ctrl, Cmd or Alt no longer fire board letters, and
  contentEditable counts as typing. Markdown gained bold and italic.
- **UI tests.** `flows.spec.ts` failed on `d42377f` itself: the new drag handle and select
  buttons made card locators match three buttons (now `exact: true`), the bulk-move toast is now
  a summary, and refused tasks stay selected. `pnpm test:ui` passes 23/23 (axe clean, 2,000-card
  board at 60 fps).
- **Secret scanner.** All-digit values and identifier-like `*_KEY` values pass; URL passwords
  (except placeholders and the literal words password, pass and secret), npm and GitLab tokens
  are found.

### Take over and release (2026-11-07)

- `releaseTask` and `takeOverTask` in core, `sati task release [--force]` and
  `sati task take-over`, `POST /api/tasks/:id/release` and `/take-over`, and buttons in the task
  panel and on the Agents page.
- Who may: the holder always releases; anyone releases an expired claim; another actor's live
  claim needs `force` (take-over implies it) and only a human actor may use it, so agents still
  cannot take work from each other. Chosen over letting any actor force, which would undo the
  atomic-claim guarantee.
- Releasing drops the holder's locks for that task, logged as the person who released. Take-over
  is a release and a claim in one transaction, so the old holder's token stops working.
- The UI server adds the person's own token to their edits, as the CLI does, so a task they took
  over is editable from the panel and the board.
- No new MCP tool: agents keep moving a task back to `todo` to give it up.
- Checked in Chrome: the panel says "codex@feature-b is working on this until 05:20 AM" with
  Take over and Release; Take over asks first, then reads "You are working on this"; the activity
  log shows release and claim by the person.

### Fencing tokens and timestamps (2026-11-07)

- `checkToken` now also requires the caller to be the claim holder. The token is the task
  version and `task show` prints it, so the token alone proved nothing. A person who needs the
  task uses `task take-over`, which the error hint names.
- Choice on "refuse completion under an expired claim": the holder may still complete after its
  lease ran out, as long as nobody else has claimed the task (its token is still current).
  Agents often work for more than 30 minutes without a sati write, and refusing would make them
  claim again for no safety gain. Another actor completing with the token is what was unsafe,
  and holder-only fencing refuses that.
- The shared `ts` schema rewrites every parsed timestamp with `toISOString()`, so imported
  records always carry exactly three fraction digits. Leases are compared as strings in core and
  in SQL, and `…:00Z` sorted after `…:00.500Z`, so such a lease looked live after it ran out.
- `pnpm test:e2e --repeat 3` (4 agents, 4 worktrees, 1,000 steps each) passes.


### Phase 7a: New task form and note tools (2026-11-07)

- The board's top bar has a "New task" button and `c` opens the same form; it replaces the
  `window.prompt` title box. Fields: title, details, priority, list (Todo or Backlog), feature
  (only shown when features exist) and comma-separated labels, deduplicated. A refused save
  shows the server's message in the dialog and keeps what was typed.
- Due date, assignees and milestone wait for the 7a task fields item, so the form has no fields
  that the server would refuse.
- MCP `note_upsert` (no id creates, id updates with `expectedVersion`) and `note_get` bring the
  toolset to 17. One upsert tool, matching `feature_upsert` and `roadmap_upsert`, instead of
  separate create and update tools, to keep the toolset small.
- Checked in Chrome at 1280 and 375 px: filled form, inline error for a 301-character title,
  the new card in Todo with its toast. The palette's input reset was hiding the text fields'
  borders; the form now sets them. The toast's Dismiss button was ink on ink and now inherits
  the toast colour.

### Phase 7a: milestone and decision forms (2026-11-07)

- The server already had the routes, so this is UI only. The New task dialog's shell became a
  shared `FormDialog` in `packages/ui/src/forms.tsx`: focus on open, Esc and Cancel close,
  submit stays off until every required field has text, a refused save shows in the dialog.
- Roadmap: "New milestone" and "Edit" per milestone. The edit sends the version the dialog
  opened with, so a change an agent saved meanwhile is refused (409) and the draft stays. The
  status list offers only the moves core allows (planned → active → done, and back one step).
- Decisions: "Record decision" (title and decision required; context, consequences, the
  features it affects, and what it replaces). Decisions stay append-only as core requires, so
  there is no edit: "Replace" opens the form with `supersedes` preselected, and the old one shows
  "replaced by …". Chosen over an edit button, which would break the decision log.
- Shortcuts now stand down for any open dialog, not only the New task one.
- Checked in Chrome at 1280 and 375 px. Tall dialogs cut off their buttons at 70vh; the dialog
  now grows to 84vh and pins the action row at its bottom while the fields scroll.

### Phase 7a: note edit, pin, tags, and delete with Undo (2026-11-07)

- Notes: Edit opens a dialog for title, body, tags and pinned, sent with the version it opened
  with. Pin and Unpin per note, pinned notes first, and tag chips filter the list.
- Delete for tasks (task panel), notes and decisions. Deletes were already soft in core, so the
  UI server gained `DELETE /api/{tasks,notes,decisions}/:id` and `POST …/:id/restore`, and the
  toast's Undo restores the record. No "are you sure" prompt: Undo is the safety net, and it
  stays 10 s instead of 6.
- The panel hides Delete while another actor holds a live claim; a person takes the task over
  or releases it first, so an agent's work is not deleted under it.
- Checked in Chrome at 1280 and 375 px: edit dialog, pinned badge and tag chips, the Undo toast,
  and the panel's Delete button.

### Phase 7a: task_list by milestone and label (2026-11-07)

- Bug: `task_list` with `milestoneId` returned nothing unless `ready` was set. The SQLite store
  filtered on the task row's own milestone column, which is always empty because tasks belong
  to a milestone through their feature. The in-memory test store ignored the filter and
  returned every task, so core's tests could not see it.
- Fix in core: `listTasks` turns `milestoneId` into the milestone's feature ids and passes them
  to the store as `featureIds` (one `IN`, so paging stays in SQL). Both the plain and the ready
  path use it. `sati task list --milestone` exposes it on the command line.
- Label filtering already worked and now combines with milestone and status. The due-date
  filter moves to the task fields item, because tasks have no due date yet; it lands as
  `dueBefore` with `dueDate`.
- Regression test through MCP on SQLite: open tasks of a milestone across two features, with a
  label, with a feature of another milestone (empty), and with `ready`.

### Phase 7a: due date, assignees and checklist (2026-11-07)

- `dueDate` is a calendar day (`YYYY-MM-DD`), not a timestamp: "by Friday" has no zone, and
  the UI reads it as a local day so it never shifts by a day across time zones.
- `assigneeIds` says who should do the task; the claim still says who is doing it now. Assignees
  must be actors of the project. `checklist` holds up to 100 `{ text, done }` steps.
- Choice on the plan's "schemaVersion goes up with a migration": no migration. The fields are
  optional and only written once set, so every existing record and `.sati/` file is still
  valid and untouched tasks keep their shape. Note: `SNAPSHOT_SCHEMA_VERSION` is declared but
  not read anywhere, and snapshot files carry no `schemaVersion`, so the Versioning rule is not
  in force yet; an older sati would refuse (loudly, importing nothing) a file with the new keys.
  That needs settling before the first release.
- Merging: `assigneeIds` is a list of ids, so the three-way set merge keeps both sides' adds.
  `checklist` is a list of objects, so the later write wins, by its field stamp.
- `task_list` gains `dueBy` (inclusive; undated tasks left out) and `assigneeId`, filtered in SQL
  with `json_extract` / `json_each`, and in the ready path.
- CLI: `--due` and `--assign` on create and update (`none` clears; `me` and actor names work),
  `--due-by` and `--assignee` on list, and `task checklist <id>` with numbered steps for
  `--add`, `--done`, `--undone` and `--remove`, guarded by the version it read. List rows show
  the due day.
- UI: the New task form has Due date and Assigned to; the task panel edits both and has the
  checklist, where ticks show at once and revert if the save is refused. Cards show
  "due Tue, Dec 1" (clay with "late" once it passed and the task is open) and "1/3 steps".
- Checked in Chrome at 1280 and 375 px.

### Phase 7a: My work page (2026-11-07)

- `/my-work`, second in the nav. Three lists, each task shown once in the first it fits.
- Order choice: approvals come first, not last as the plan listed them. They are the only
  list where work is blocked on this person, and an agent waits on each one.
- "Waiting for your approval": tasks in review assigned to you or to nobody. Any person may
  approve in core, so an unassigned review task is everyone's; one assigned to someone else is
  theirs. Your own completed work is not left out: with `--review all` a solo owner asked for it.
  Each row shows who finished it, the summary and the file count, with Approve (review → done)
  and Send back, which needs a reason that becomes the task's review note for the next claimer.
- "Assigned to you": open tasks, soonest due first, undated last, then priority.
- "Due by Sunday": open tasks due on or before the coming Sunday in local time (late ones
  included); the heading names the day.
- The phone nav kept "My work" on two lines, which made the bar taller and made the Activity
  page scroll, so axe flagged it; nav labels now stay on one line.
- Checked in Chrome at 1280 and 375 px.

### Phase 7a: People (2026-11-07)

- Actors gain optional `displayName`, `initials` and `color` (one of eight named colours with
  white-text contrast in both themes). `name` stays the identity sati looks actors up by.
- `updateProfile` in core, `PATCH /api/actors/:id` in the UI server. Only a person may edit, and
  only people have a profile; agents keep their session name, because which session did the work
  matters. No version check: an actor's version moves on every write it makes (clock stamps).
  `null` clears a field back to the default.
- Defaults in the UI: a person without a display name shows as the user part of
  `user@worktree`, so the same person reads the same in every worktree; initials are the first
  graphemes of the first two words (Khmer clusters stay whole); the colour is picked from the
  shown name.
- Settings page (`/settings`) with the People list and an Edit dialog that previews the avatar.
- Known limit: actors are not in the `.sati/` snapshot, so a profile lives in each clone's
  database and a teammate's clone shows their own defaults. Syncing profiles needs actors in the
  snapshot; left for the sync work.
- Fixed while testing: two quick checklist edits in the task panel both sent the version the
  panel opened with, so the second was refused and the tick reverted. Checklist saves now run in
  order, each with the version the previous save returned.
- Colour radios meet the WCAG 2.2 target size (axe flagged the default 13 px radios).
- Checked in Chrome at 1280 px; axe on Settings and the Edit person dialog at 1280 and 375 px.

### Phase 7a: plain words in the UI (2026-11-07)

- All board wording lives in `packages/ui/src/words.ts`; `docs/guide/glossary.md` maps it to the
  CLI, MCP and file terms, which do not change.
- Columns and status pickers: To do, Working on it (`in_progress`), Waiting for approval
  (`review`). Values sent to the server are unchanged.
- Times: claims, leases and reservations read "until 2:32 PM" in the reader's zone and clock
  style, with the day added when it is not today; tooltips show the local date and time instead
  of the ISO string; milestone dates use the reader's date format.
- Activity rows are sentences ("started working on the task", "finished the task and sent it
  for approval", "joined the project", "restored the note").
- Refused saves: the server's messages are for agents, so the UI rewrites the common ones
  (stale version, task held by someone, reserved files) and drops hints that name a CLI command.
  The server and CLI messages stay as they are.
- Agents page: "Person" / "AI agent", "Reserved src/** for editing until …" instead of
  "exclusive lock", "Free up tasks whose time ran out". Merge flags read "edited in two places ·
  Looks right".
- The longer Activity sentences made the page scroll at 375 px with nothing focusable, so axe
  flagged it; the Activity page is now a focusable region.
- Checked in Chrome at 1280 px: board, task panel, Agents and Activity.

### Phase 7a: project kind (2026-11-07)

- `kind` lives in project settings (`code` | `general`) and is written only for `general`, so
  existing projects, their rows and their `.sati/` files are unchanged; switching back to code
  removes the key. Set with `sati init --kind`, `sati settings --kind`, or Settings in the UI
  (`PATCH /api/settings`, kind only; review and lease stay CLI settings).
- General: the UI hides Features and Agents in the nav (a deep link says why), the feature
  filter, feature names on cards and file reservations. Features and locks left over from a code
  project stay in the store and come back if the project switches back.
- General: `sati guard` (staged, range, paths and the Claude Code hook) passes without checking,
  since there are no features or locks to protect. The hooks stay installed, so switching back
  turns the guard on again with nothing to reinstall.
- General: MCP leaves out the four feature and lock tools, the feature resource and the
  plan-feature prompt, so agents never see them and their schemas cost no tokens. The server
  reads the kind when it starts; an agent picks up a change on its next session.
- General: init and `sati rules sync` write a six-rule block without feature, lock, context or
  `--no-verify` rules (text in PLAN). After `settings --kind`, run `sati rules sync` to swap it.
- Board, both kinds: a board with no features no longer shows a "No feature" heading in every
  column.
- Found: tasks join a milestone only through their feature, so a general project cannot group
  todos under a plan yet. Added to 7a as `milestoneId` on tasks. The workflow resource and skill
  still describe feature steps; a general variant is added to 7a too.
- Checked in Chrome at 1280 and 375 px: Settings with each kind, the board and the nav.

### Phase 7a: plans for general projects (2026-11-07)

- Tasks carry an optional `milestoneId`, written only once set like the other planning fields,
  so no migration: the store's generic `milestone_id` column already fills from the record.
  `task_list` with a milestone now matches `milestone_id = M OR feature_id IN (M's features)`
  in one query (`ListQuery.inMilestone`, replacing `featureIds`, which only this used).
- Subtasks join their parent's milestone, as they already joined its feature.
- The Plan picker lists open milestones, plus the task's own even when it is done.
- General projects get their own workflow page, resource and Claude Code skill. Both workflow
  constants come from `docs/guide/` through the same generator, and a test fails if they drift.
- `task_complete` no longer needs files touched in a general project (booking a venue touches
  none). Code projects still refuse an empty list, now in the service instead of the schema, so
  a done record with no files is valid on disk. The MCP description says which applies.

### Review: bloat and bugs (2026-11-07)

Measured: the MCP tool list an agent loads each session was 16,497 characters (about 4,100
tokens) for a code project; the brief is capped at 1,500 tokens; the board's main bundle is
105 KB gzipped from localhost; a CLI call takes about 0.13 s. The tool list was the one cost
worth cutting.

- MCP link fields (`featureId`, `milestoneId`, `parentId`, `dependsOn`, `assigneeIds`,
  `assigneeId`, `featureIds`, `supersedes`, `decisionId`) take short handles and are resolved
  before core sees them. Before, `task_list` with a handle silently matched nothing and the
  create and update tools refused it, so the agent retried with a full id it had to look up.
- Calendar days use a short pattern plus a real-day check instead of `z.iso.date()`, whose
  330-character leap-year regex was in every date field of the tool list. Same rule.
- The "full id or short handle" description, repeated in 27 fields, is said once in the server
  instructions. Tool list now 15,056 characters (about 3,760 tokens), general projects 11,978.
- Fixed: the project kind lived only in the local database, so a teammate's `init` made a
  general project `code` again and rewrote the committed AGENTS.md. `kind` is now in
  `.sati/sati.config.json` (written only for general); init reads it, `settings --kind` and the
  UI write it, and `sync import` (the post-merge and post-checkout hooks) adopts a switch.
- Fixed: actors are not in the snapshot, so assignees from another clone were dropped when the
  task panel saved, and core refused any update that kept them. Core now checks only newly
  added assignees; the panel shows them as "Someone on another computer", still ticked.
- Fixed: ticking a checklist step remounted the task panel form and lost unsaved typing. The
  form now reloads only when a field it edits changes; it sends only its own fields, so changes
  to other fields are never overwritten.
- Fixed: `task list --assignee none` or two names listed every task; it now asks for one.
  `sati://project/roadmap` counted only the first 500 tasks. The general workflow no longer
  asks for files touched.
- Removed duplication: status words come from one table, the New task form says "To do",
  init and guard share one config reader, two unused exported types are gone.
- Not changed: a deleted task still blocks the tasks that depend on it (the ready query treats
  a missing dependency as not done). Older behaviour; left for a decision.
- Recommended, not done: comments as notes tagged `comment` and linked to the task, note or
  decision, the way handoffs already work, instead of a new entity with its own table,
  triggers, snapshot folder and MCP tool.

## 2026-11-07 — Comments, compact answers, deleted dependencies, leaner plan

The owner accepted the four recommendations above.

- Comments are notes tagged `comment` with one link, like handoffs: no table, migration,
  snapshot folder or MCP tool. Core `addComment` names the note "Comment on <title>" and refuses
  features and milestones, deleted records, blank text and replies to a comment (threads are one
  level). CLI `sati comment add|list` shows authors by display name. MCP has no new tool: a new
  `note_upsert` tagged `comment` with exactly one link goes through `addComment`, so agents need
  no title and get the same checks. The UI thread is open in the task panel and folded under each
  note and decision; its fold keeps its own state, so a refresh never hides a half-typed comment.
  Threads are indexed once per snapshot, not filtered per row. Comment notes stay out of the
  Notes list and tag filter.
- Fixed while testing: two comments in the same millisecond put the older one in the brief,
  while the thread showed the newer last. Both now order by time, then id.
- The brief shows the newest comment by someone else on each claimed task (your own replies are
  left out), clipped to 200 characters and fenced as data, so "use the blue logo" reaches the agent without growing the brief much.
- MCP `task_list` returns short rows unless `detail: "full"`: 20 tasks went from 30,571 to 2,811
  characters. `search` hits drop the BM25 rank. The tool list grew 248 characters (15,304; general
  12,226) for the `detail` field and the comment hint.
- A deleted dependency no longer blocks (SQLite and memory stores); a missing id still does.
  Cancelled dependencies stay an owner decision in `docs/ideas.md`.
- Plan trimmed: changelog and digest become formats of `sati changes`; `review --since` is
  dropped; calendar export, email and Telegram notifications, link attachments and the token
  ledger moved to `docs/ideas.md`.

## 2026-11-07 — Polish pass: review, dead code, every page

Three read-only reviews (bugs in the last two commits, unused code, every UI page at 1280 and
375 px in light and dark), then fixes.

- Fixed: the kind in the database and in `.sati/sati.config.json` could disagree. An explicit
  `init --kind` in a clone is now recorded in the config, the wizard starts from the committed
  kind, and the config always records `kind` (both values). A config without it (made before
  kinds) is "no opinion": `sync import` no longer resets such a project to code.
- Fixed: comments could be moved, untagged or rewritten through `note_upsert` or
  `PATCH /api/notes`, still credited to their author. Notes cannot gain or lose the `comment`
  tag, a comment's links, tags, title and pin are fixed, and only its author edits its text.
  `note_upsert` refuses a title, pin or extra tags on a new comment instead of dropping them.
  `comment list` refuses a deleted record by full id as it did by handle.
- Fixed: a search hit for a comment whose record was deleted closed the palette and did
  nothing; it now says so. Hits show their kind (Task, Note, Comment …), a comment shows what it
  is on, and the palette says to press Enter.
- UI fixes: Search no longer floats mid-bar off the board; the phone top bar wraps the filter
  onto its own row and the nav scrolls the current page into view; labels show on cards and in
  the panel; Markdown renders pipe tables, quotes, and a list right after a paragraph line;
  comment lists lost a stray second bar and the Comment button sits beside its box; panel values
  are no longer grey; toasts lay out as text plus actions with a filled Undo; bulk moves say why
  they failed; handoffs left the Notes list and read "left a handoff on" in Activity; features
  show their description, a paths label and capitalised status; milestones and priorities are
  capitalised and a milestone's features are labelled; a replaced decision is dimmed and has no
  Replace; unresolved feature ids no longer show on decisions; the task panel shows priority,
  feature, labels, "What was done" for finished tasks, a labelled Status, a Details heading and
  Delete at the bottom; empty board messages are padded and say no CLI commands; My work says
  "Nothing is due" when nothing is; the page title names the page.
- Accessibility: the page behind the task panel, New task and Search is `inert`, so Tab stays
  in the dialog; control borders use a new `--line-strong` at 3.5:1 (light) and 3.5:1 (dark)
  against the panel, up from 1.46:1 and 1.37:1; checkboxes and radios use the theme colour.
- Removed: `commands/snapshot.ts` (top-level `export`/`import` now are `sync export`/`sync
  import`, so `import` also adopts a kind switch; `export --all` is still accepted), the unused
  `backupDir` store option, `IdPrefix`, `detectTools`'s unused parameter, the unused
  `__CLI_NAME__` define, and two `?? 30` lease literals (now `DEFAULT_LEASE_MINUTES`).
- Not changed, noted for later: MCP has no tool to read a whole thread (search and `note_get`
  reach comments); the board loads the newest 2,000 notes, comments included; test-only exports
  in core stay so tests can reach them; `SNAPSHOT_SCHEMA_VERSION` is still unread and needs an
  owner decision.

## 2026-11-07 — Latest comment in the short brief

The resume and compact hooks run `brief --format=short`, which read no notes, so an agent that
resumed mid-task missed a person's new comment until its next fresh session. The short brief now
shows the newest comment by someone else on each claimed task, as the full brief does. It reads
notes only when the caller holds a task; handoffs stay out of it, as before.

## 2026-11-07 — Phase 5b closed

- `task update --status in_progress` on an unclaimed task claims it for the caller with a
  fencing token (the new version, as `task claim` does). Later writes need the token; the CLI and
  the board fill it in for the holder. A claim held by someone else is still refused first.
- A cancelled dependency no longer blocks, like a deleted one (decision recorded in sati). A
  missing dependency id still blocks, and doctor now names it.
- `importRecords` runs `linkProblems` on the tasks it imported, inside the same transaction:
  cycles among waiting tasks (done, cancelled and deleted ones break a cycle) and links to
  missing features, milestones, parents and dependencies. It reports instead of refusing,
  because a merge can produce them and a refused import would stop every git hook until someone
  edited `.sati/` by hand. `sync import` prints them even with `--quiet`; doctor has a `links`
  check over every task.
- Limits: bodies are 100 KB of UTF-8, measured without allocating (`utf8Bytes`); the character
  cap is still checked first so a huge string is refused before it is measured. A `subtasks[]`
  batch is capped at 1 MB in total.
- Brief: the actor name is clipped to 60 characters. When dropping items is not enough,
  sections left empty fold into one closing line, bottom up. With all eight sections present at
  the 200-token minimum it came to 216 tokens before and fits now.
- Search: punctuation inside a word becomes a phrase of the indexed tokens (`v1.2` → `"v1 2"*`).
- MCP: the server takes the repo root; `feature_check` and `lock_acquire` turn an absolute path
  inside it into the repo-relative one (the lock tool's schema takes plain strings, since the
  SDK validates before the handler runs). `feature_upsert` names update-only fields on a create.
- Hooks: init leaves a global `core.hooksPath` outside the repo alone unless asked (wizard
  question, or `--global-hooks`), and says so in its output; a hook in another language is left
  byte-identical with a note. `.claude/settings.json` keeps its key order: the merge checks the
  shape with Zod but edits the original objects, since Zod output puts known keys first.
- UI: the board's columns and lanes come from one function (`boardColumns`), which j/k reads
  too, so keyboard order is screen order. j/k open cards through the URL, so Back and Forward
  work, and they work from the open panel's heading. The Features paths field is keyed by its
  paths, as the task panel's form is by its fields: typing survives refreshes, and a change made
  elsewhere shows when nobody is typing (before, the field never picked one up and Save sent the
  old text back). Phones switch between one and all columns with a width listener; the stale
  session page is a 401 HTML page for page requests only.

## 2026-11-07 — Phase 7b: what changed, changelogs and feature lists

- `task_complete` takes an optional `releaseNote` (one line, at most a title's length). It lives
  in the task's completion, which the snapshot already carries, so `.sati/` files gain the key
  only on tasks that use it.
- `listChanges` (core) reads the records, not the activity log: done tasks by `completedAt`,
  features by the clock stamp on `status`, decisions by `createdAt`, notes by `updatedAt`
  (comments and handoffs left out). Activity rows stay machine-local, so a log-based list would
  miss everything a teammate pushed; the records come through git with their stamps. A new
  `updatedSince` list filter uses the existing `(project_id, updated_at)` index.
- `since`: a day, a UTC time, `24h`/`7d`/`2w`, `last-session`, or a done milestone (from when
  its status became done). Anything else is a VALIDATION error naming the forms.
- Last session (decision recorded in sati): the caller's previous last write, from activity, not
  counting sati's own writes (`import`, `release`, `init`). An agent gets a new actor per session
  (`claude-code@repo#a1b2`), so its sessions are the actors with the same name before `#`, and
  its current session is skipped. No new field or `brief` verb: every input already exists, and
  a brief that wrote a row would move the mark on every read. The brief reads the mark before it
  releases expired claims, which are writes in the holder's name.
- The brief's "Since your last session" shows up to 5 changes by others, with who and when, and a
  pointer to `sati changes --since last-session` for the rest. It sits above recent decisions,
  so the fit drops it before the task sections. With no earlier session it is left out.
- Formats are text renderers of one result (`formatChanges`): `plain` grouped by milestone with
  blocked and overdue tasks; `changelog` as Added / Changed / Fixed / Removed from labels
  (`bug`/`fix` → Fixed, `feature`/`new` → Added, `removed` → Removed, else Changed) and feature
  status (shipped → Added, removed → Removed, deprecated → Changed), oldest first, without
  tasks labelled `internal`; `digest` as counts, shipped features, top 5 done, top 3 decisions
  and what needs attention. Each list is capped so a long window stays readable.
- `sati feature list --format md` prints shipped and deprecated features with the first paragraph
  of the description and the acceptance criteria, by milestone.
- MCP `changes` returns text, like the brief (18 tools). The board's Changes page calls
  `GET /api/changes` and `GET /api/feature-list`, which run the same core functions, and groups
  the timeline by the reader's local day. Copy uses the Clipboard API (127.0.0.1 is a secure
  context); a refusal shows in the toast.

## 2026-11-07 — Phase 7a: parity test

- `e2e/ui/parity.spec.ts` runs each capability twice against one `sati ui`: by clicking in the
  board and through `sati mcp` over stdio (the real binary, as an agent runs it). Task with plan
  fields, checklist, milestone, note (tags, pin, edit), decision (replace) and comment. Both
  records are read back through the CLI and compared with ids, times, versions, stamps and lease
  details removed and each side's own ids mapped to names. Each test also checks the expected
  values on the UI record, so two empty records cannot pass by matching.
- It found that the toast covered a dialog's pinned action bar for about five seconds after a
  save: the Replace decision button did not respond to a quick click. While a dialog is open the
  toast now shows at the top of the screen. The decision flows went from 7.7 s to 1.9 s.

## 2026-11-07 — Phase 7c: plan templates

- A template is Markdown: `# Title`, `Goal:` and `Labels:` lines, `## Stage (-6w)` headings and
  `- [ ]` tasks, with indented boxes as checklist steps. `applyTemplate` (core) writes the
  milestone and every task in one transaction, after validating every input, so a refused
  template leaves nothing. Each stage's tasks depend on all of the stage before, so only the first
  stage is ready; with a target day, a task is due at its stage's offset.
- Three starters are built in (event 18 tasks, campaign 14, release 18). A project's own files
  in `.sati/templates/` replace or add to them. The CLI reads them on every call; only regular
  files under 200 KB with a lowercase dash name are read, so a symlink in a cloned repo is never
  followed. Core takes the files as data and does no I/O.
- A second plan with the same name (case-insensitive) is a CONFLICT: applying a template twice by
  accident would double every task.
- One surface per client, no new tool: `sati template list|show|apply`, MCP `roadmap_upsert`
  with `template` (its description lists the template names), and the Roadmap page's New plan
  dialog over `GET /api/templates` and `POST /api/templates/apply`.
- `.sati/templates/` is the one folder in `.sati/` people edit; the rules blocks and workflow say
  so. Snapshot export and import only touch the record folders, so the templates are left alone.
- Fixed while here: `sati plan import` created a milestone per heading but left its tasks
  outside it. Each task now joins its heading's milestone.


## 2026-11-07 — Phase 8: knowledge brain

- sati remembers; agents read. Context entries became **cards**: optional `facts[]` (up to 50,
  300 characters each), `tags[]`, `sourceSeen` (the file version the agent read) and
  `sourceTokens`. A later `context_put` replaces them, so a dropped fact does not linger.
  Git-mode staleness is unchanged. `sati card` is an alias of `sati context`.
- There is no snapshot `schemaVersion` to bump. The new fields are optional, so this version
  reads every older snapshot. An older sati refuses the whole import of a newer card ("Unrecognized
  key") and keeps nothing half-imported, the same as every earlier field addition; its hint now says
  a newer sati wrote the files and to update.
- Secrets are refused on write, not only on export: notes, comments and cards go through the same
  scanner (moved to `core/domain/secrets.ts`; `@sati/sync` re-exports it). The error names the
  field and never echoes the match.
- Search covers cards (migration `0004_fts_cards`: path as title, summary, facts and tags as body,
  with a backfill).
- `recall` (core, `sati recall`, MCP `recall`, 19 tools, and the board's Ask box) drops stop words,
  searches for all the words and then any, keeps open tasks only, ranks each card's facts by the
  question, and returns Markdown inside a `data` block capped at 1,000 tokens with an omitted
  count. No model or embeddings in sati.
- **Private** (`private: true`, `--private`, "Keep on this computer only"): never exported to
  `.sati/`, and an import never brings in or overwrites a private record. It is set when the item
  is made; making a shared item private is refused, because git already has it. A comment on a
  private note is private too. `sati doctor` lists private items (information only, never a
  failure). Chosen: flags on `note create|update` and `card put` instead of separate
  `note pin|private` commands the design doc sketched, to keep the CLI small.
- The brief's Knowledge section holds up to 3 newest pinned notes and up to 3 cards tied to my
  claimed tasks (through the feature's paths or a label matching the card's tags), inside the
  1,500-token cap. Pinned notes also show above the board.
- Rules blocks and both workflow guides: check a file's card before opening it, save one after;
  general projects ask `recall` first.
- Board: Memory page (Ask box with Copy as Markdown, cards by folder with facts, filter, New card
  and Edit card, Private and "Changed since" badges); search palette opens card hits on Memory.
  Checked at 1280 and 375 px; axe covers the page, the answer and the card dialog.
- Budgets: `pnpm bench` now measures `recall` on 50,000 records including 2,000 cards: p95
  49.7 ms against 50 ms in this orb, where `search` was 49.5 ms (47.3 ms on the previous commit).
  The CLI read budget (150 ms) fails in this orb on the previous commit too (222 ms), so it is the
  orb, not this phase; cold start is unchanged (p95 48 ms against 46.5 ms, interleaved runs).
- Gate: "No private item appears in `.sati/`" is tested in core, the CLI and Playwright (a
  mutation that exports private records fails the UI test). The token-saving gate (20 questions on
  a real folder of Office and PDF files, at least 70% fewer tokens in a fresh session) needs a
  manual run with an agent tool's own usage report; it is part of the real-project trial.

## 2026-11-08 — Real-project trial 1: an event office folder

- Setup: the packed `@kongpda/sati` tarball installed globally (10 s), `sati init --kind general`
  in a folder outside git (standalone, 0.3 s), and a sample Spring Fair folder of 9 real files
  (3 PDF, 2 Word, 3 Excel, 1 PowerPoint). A person made the plan on the board from the Event
  template with the fair's date (18 tasks, due dates counted back) in under a minute, recorded 3
  decisions and 2 notes, and assigned an agent 20 committee questions (one about confidential pay).
- Session 1: a fresh agent with only the CLI read all 9 files, answered 20/20 with sources, saved 9
  cards (the HR one private) and a note listing 3 risks it found by comparing files.
- Between sessions the venue quote was revised and 4 more stalls paid. Session 2, a fresh agent,
  answered 20/20 correctly, re-reading only the 2 changed files: file reading went from about
  16,200 to 4,400 tokens (73% fewer). It kept the confidential rate out of the answers.
- Measured as tool output (characters / 4), not the agent tool's own usage report, which the
  subagents do not expose; the Phase 8 gate still needs that report from a real agent tool.
- Fixed from what the trial showed:
  - Outside git a card could never tell its file had changed; session 2 found the 2 changes only by
    comparing modified times itself. Standalone folders now list files by size and modified time
    (`stat` only; sati still never opens them, skipping dot folders and `node_modules`, at most
    20,000 files), so `stale` works there. A card saved before this has no hash and reads "not
    checked", not "changed". Rules, workflow and tool descriptions now say to trust `stale`.
  - Session 2 spent more tokens on sati than on the files: `task list --json` (42 KB) and
    `card show --json` were mostly merge stamps. The CLI's `--json` and every MCP result now drop
    `stamps`, and `task list` returns short rows unless `--full` (as MCP `task_list` already did):
    42 KB → 7.6 KB here.
  - Recall returned 14 records for "What does Menu B cost per head?", most sharing only "b" or
    "per", including the private pay card. A question of four or more words now needs two shared
    words for a partial match; that answer is now 2 records and 241 tokens.
  - Both agents had to map MCP tool names to commands; both rules blocks now end with the CLI
    command for each step. `task complete` says when the task waits for a person.
  - Board: To do held all 18 template tasks as if each could start; a card now says "waits for
    3 tasks". Due dates in another year show the year. Labels no longer touch the date, and select
    sits at the card's end. A phone opens on the first column with tasks, not an empty Working on
    it. A second plan with the same name now says what to do on the board too.
- Still open from the trial: comments get `note_` ids (by design, documented in the glossary),
  and `sourceSeen` stays free text; with staleness outside git it is now only for people.
- PLAN "Try it on 3 real projects for 1 week" stays open: this was one simulated project in an
  afternoon, with the owner's real folders still to come.
### Phase 5c: coordination signals (2026-11-07)

- Started before the Phase 5b gate closed, at the owner's request ("add it all"). 5b's open
  items stay open.
- No schema migration: `claim.waiting`, `claim.holder`, `completion.commit|branch|approvedCommit`,
  `blockedReason`, `note.handoffTo` and `note.acknowledged` are optional and written only once
  set.
- Commit order for the cursor is the SQLite `rowid` of the activity row, because writers queue
  and append inside their transaction. Ids and `at` come from each process's clock and can sort
  differently. `VACUUM` keeps rowid order. An unknown cursor is NOT_FOUND, and the UI then
  starts over.
- Stopped holders: only the MCP server names itself on a claim (`ProcessProbe.self`), because
  a CLI command exits at once and would look dead. `kill(pid, 0)` returning `ESRCH` is the only
  proof; `EPERM` counts as alive, and another host is unknown. The host is a SHA-256 prefix of
  the hostname, since claims are exported to `.sati/`. Breaker: 3 or more stopped holders that
  are also the majority of probed ones means the check is wrong (a container, another PID
  namespace), so none are released and `doctor` says why.
- Waiting: a person may clear another actor's wait; only the holder may set one. Setting it
  renews the lease, so an agent waiting on a person keeps its task. The `Notification` hook
  marks every task the caller holds; `UserPromptSubmit` clears them. Both hooks never block.
- Review pin: the approval compares `approvedCommit` with the branch head read from git before
  the transaction. Without `approvedCommit`, the approval records the head it happened at. The
  board sends the head it showed, so a push between seeing and clicking is refused.
- Overlaps read `git diff <base>...HEAD` plus `git status` per worktree, only for worktrees git
  lists (`git worktree list`), so a task record cannot point sati at an arbitrary folder. Up to
  10 worktrees and 20 overlaps; computed only for agents holding a claim. `.sati/` and untracked
  folders are ignored: every agent's writes export to `.sati/`, which the first real-git test
  caught.
- Handoffs: reading your own unaddressed handoff back on a re-claim does not mark it read, so
  the next agent still gets it.
- The UI's "Needs you" says to answer in the agent's session: sati does not pass messages.
  Agent text is rendered as plain text.
- Checked in Chrome at 1280 px: My work (Needs you, review drift with "Approve latest"), board
  card badges ("needs you", blocked reason), the task panel handoff box, and "I answered"
  clearing a question without taking the claim. Seen but not changed: the open task panel
  covers part of the board, and the "Assigned to" list in the panel clips its last row.
- Not done: `sati rules sync` has not been run on this repo, so `.claude/skills/sati/SKILL.md`
  still has the old workflow text.

### Compact snapshot files (2026-11-07)

- Asked by the owner after measuring the footprint: a new task's file was 1.6 KB, over half of
  it the same clock stamp repeated per field.
- `packages/sync/src/format.ts` encodes on export and in the merge driver, and decodes on
  import and before a merge. Required fields at their empty value (the first of null, [], "",
  false the Zod schema accepts) are left out; the most common stamp is written once as
  `stamps["*"]` and applies, on read, to every field outside a fixed unstamped set that has no
  stamp of its own.
- Every record is decoded again before it is written; one that would not come back exactly
  (a field without a stamp, say) is written with full stamps, or in the full form. So the format
  cannot lose a field or a stamp; a property test checks the round trip, and fails when the
  fallback or the rule for stamps of cleared fields is removed.
- Old full-form files read unchanged. The first export after upgrading rewrites every file once.
  A sati build from before this rejects compact files on import (strict schema); nothing is
  published yet, so no one has one.
- Measured, 200 new tasks: 343,917 bytes to 107,917 on disk; 43 KiB to 30 KiB packed in git.

