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

- Package names use the placeholder `@scope/brain`; internal packages use the private `@brain/*` scope and are bundled into the CLI.
- Biome does not format or lint Markdown, so hand-written docs (`PLAN.md`) are not rewritten.
- TypeScript 7.0.2 is used. tsdown warns its declaration emit on TS 7 is experimental. If d.ts output breaks, pin TypeScript 5.x and record an ADR.
- `@types/node` is pinned to `^22` to match the lowest supported Node.

### Verify output (local, 2026-11-03, macOS, Node 26.12.1)

```
pnpm lint       Checked 19 files. No fixes applied.
pnpm typecheck  Tasks: 3 successful, 3 total
pnpm test       @brain/core 1 passed; @scope/brain 1 passed
brain --version 0.0.0   (from dist and from an npm-installed packed tarball)
changeset status: @scope/brain patch -> 0.0.1
```

### Decision 2026-11-03

Owner chose to keep the `brain` / `@scope/brain` placeholder for now. Name, npm scope and the publish gate are deferred.

### Gate remaining

The gate is "`brain --version` publishes to npm as `0.0.1` from CI". It needs:

1. Final product name and npm scope (then edit `packages/core/src/name.ts` and the `@scope/brain` package name).
2. A GitHub repo with this code pushed.
3. npm account 2FA, and an `NPM_TOKEN` secret (or npm trusted publishing) on the repo.
4. Merge the "Version Packages" PR that the release workflow opens.

## Phase 1 — Core, SQLite and CLI

Status: **gate passed** (2026-11-03). Waiting for review before Phase 2.

### Choices made on ambiguous items

- Storage port is async (ADR 0001) so Postgres and remote adapters reuse the same services.
- One project per DB. `brain init` refuses to run twice (CONFLICT).
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
- Actor identity: `BRAIN_ACTOR` wins; otherwise an agent is `<tool>@<worktree>#<session8>` and a
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
  command (over the 150 ms budget); bundled, `brain task list` takes ~80 ms. `brain --version`
  loads only the name constant (~30 ms).
- `brain init` picks git mode inside a repository and standalone outside one; standalone inside
  git (and git or stealth outside git) is rejected. It asks questions only on a TTY. Without a
  TTY it writes nothing unless `--yes` is given; with `--json` the error carries the preview.
- `brain init` only reports detected agent tools in Phase 1. Writing their configs, hooks and
  rules is Phase 2 work, so the preview lists just `.brain/brain.config.json` for now.
- A committed `.brain/brain.config.json` (as in a fresh clone) is kept, and its project id is
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
@brain/core:test:       Tests  70 passed (70)
@brain/core:test: All files      |   97.67 |    91.95 |   94.25 |   98.53 |
@brain/store-sqlite:test:       Tests  24 passed (24)
@scope/brain:test:       Tests  17 passed (17)
 Tasks:    6 successful, 6 total
@scope/brain:bench: Seeded 50000 records in 8178 ms.
@scope/brain:bench: PASS  CLI cold start (brain --version), p95               37.8 ms  (budget 80 ms)
@scope/brain:bench: PASS  CLI read command, p95                              122.0 ms  (budget 150 ms)
@scope/brain:bench: PASS  Full-text search on 50000 records, p95              31.0 ms  (budget 50 ms)
 Tasks:    4 successful, 4 total
```

In a temp git repo:

```
$ brain init --yes && brain task create "x" --json && brain task list --ready --json
Initialized "tmp-cssdvnffcf" in git mode.
  database  /private/var/folders/29/x0cgr_ld17l7y66k0qkdhl880000gn/T/tmp.CssdvnFFcf/.git/brain/brain.db
  created   .brain/brain.config.json
  tools     claude-code
Next: brain task create "First task"
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

- **MCP tool set.** PLAN lists 14 tools, but `lock_acquire`/`lock_release`, `context_get`/`context_put` and `feature_check` need the locks, context cache and guard services, which are Phase 3 checklist items. Phase 2 registers the tools whose services exist (`task_list`, `task_create`, `task_claim`, `task_update`, `task_complete`, `feature_upsert`, `decision_record`, `search`, plus `brain_brief`). The other five land in Phase 3 with their services. The Phase 2 gate (an agent finishes a real task with brain tools only) needs only the first set.
- **Basic claims now, leases with heartbeats and fencing later.** `task_claim` needs a claim, so core gains `claimTask`: one write transaction (`BEGIN IMMEDIATE` in SQLite) that fails with CONFLICT naming the holder while another actor's lease is live, moves the task from `todo` to `in_progress`, and logs a `claim` activity row. The lease length defaults to the project's `leaseMinutes`. Following "leases renew on any write by the holder", the holder's `task_update` renews the lease; moving a task back to `backlog`, `todo` or `cancelled` drops the claim so it shows up as ready again. Heartbeats, concurrency stress tests and fencing tokens remain Phase 3 items.
- **Tool results** are compact JSON (no indentation) to save agent context. Domain errors come back as tool errors carrying `{ error: { code, message, hint, details } }`, matching the CLI's `--json` errors. Schema errors caught by the SDK come back as its plain-text tool error.
- **Ids.** Tools accept full ids or short handles (`tsk_8f3k2a`); resources print short handles.
- **`brain mcp`** loads the MCP SDK lazily so other commands keep their cold-start budget. The SDK stays an external dependency of the CLI; workspace packages are bundled as before. The stdio transport does not report a client disconnect, so the server also stops when stdin ends.
- **The brief** (`brain brief`, `brain_brief`) is Markdown in four sections: your claimed tasks with their feature's acceptance criteria, ready tasks, decisions from the last 7 days, and protected features with their paths. Empty sections say so in one line (or are left out for decisions and protected features). `--format=short`, for resumed and compacted sessions, keeps only your tasks and the top three ready ones. Tokens are estimated as characters / 4; when the brief is over its cap (1,500, or a lower `maxTokens`), items are dropped from the bottom section up and a "… N more left out" line is added. Lines are clipped to 160 characters. The project has no description field, so the "what the project is" paragraph is its name, mode and the caller's identity.
- **Deferred from the brief:** clearing expired leases (the brief is a read; lease cleanup comes with the Phase 3 leases item), others' active locks and stale context entries (Phase 3 services), and "changes since my last session" (needs a per-actor session marker that the plan does not define yet).
- **Duplicate detection.** `task_create` searches before it creates (so the new task never matches itself) and returns the task plus `similar`: up to three existing tasks, best first. FTS finds candidates sharing any significant title word (3+ letters, minus a short list of words common in task titles such as "add", "fix", "update"); a candidate counts when the Dice overlap of significant title words is at least 0.5. Done tasks are kept, since redoing finished work is duplicate work too; cancelled ones are skipped. The task is still created: the agent decides, and the tool description tells it to cancel the new task if one match is the same work. Only the MCP tool reports matches; `brain task create` is unchanged.
- **Agent files.** `brain init` sets up the tools it detects (marker files, or the agent running it) plus any named with `--tools`. Every project gets the managed block in `AGENTS.md`. Claude Code gets `@AGENTS.md` in `CLAUDE.md` and a `brain` entry in `.mcp.json`; Codex gets `[mcp_servers.brain]` in `.codex/config.toml`; Cursor gets `.cursor/mcp.json` and `.cursor/rules/brain.mdc`; Gemini CLI gets `.gemini/settings.json` and a block in `GEMINI.md`. MCP configs are merged: other servers and keys are kept, a `brain` entry the user already wrote (say, one running through `npx`) is left alone, and a config that is not valid JSON stops init before anything is written. The MCP command is `brain mcp`, which assumes the CLI is on PATH.
- **Stealth mode** must leave `git status` clean, so it never edits files that already exist (they are reported as `skipped`), puts the rules block in `CLAUDE.local.md` instead of `AGENTS.md`/`CLAUDE.md`, and lists every file it creates in `.git/info/exclude`. Files listed there stay brain's to update.
- **The rules block is the plan's text word for word**, so it already names Phase 3 tools (`feature_check`, `lock_acquire`, `context_get`, `context_put`). Until Phase 3 lands, agents will not find those tools. The block is versioned (`v1`), and `brain rules sync` rewrites it.
- **Managed rules files.** Blocks go into `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md` and a single-file `.clinerules`. brain owns whole files at `.cursor/rules/brain.mdc` (`alwaysApply: true`), `.windsurf/rules/brain.md` (`trigger: always_on`), `.kiro/steering/brain.md` (`inclusion: always`) and `.clinerules/brain.md`; these still carry the markers, so drift checks can treat every file the same way. Any older `v<n>` block is replaced in place.
- **`brain rules sync`** reruns the same plan as init for the tools detected now (plus `--tools`), so it also adds missing MCP entries. It reports `create`/`update`/`keep`/`skip` per file and "Everything is up to date." when nothing changed. Drift reporting in `brain doctor` comes with the Phase 5 doctor item.
- **Claude Code hooks** go into `.claude/settings.json` (`.claude/settings.local.json` in stealth mode, which Claude Code treats as personal). SessionStart runs `brain brief --format=agent` on `startup|clear` and `brain brief --format=short` on `resume|compact`; Stop runs `brain nudge`. The merge keeps every other setting and hook, and adds a group only when its command is not already there, so a user can reorder or edit ours freely.
- **`brain nudge`** lists the tasks the caller holds a live claim on (`in_progress`, `review` or `blocked`). As a Stop hook (`hook_event_name: "Stop"` on stdin) it prints `{"decision":"block","reason":...}` so the agent completes or updates them, but only once: with `stop_hook_active` set it prints the reminder as plain text and lets the stop through. With no held tasks it prints nothing. Errors exit 1, not their usual code, because Claude Code reads exit 2 from a Stop hook as "block".
- **The skill** (`.claude/skills/brain/SKILL.md`) is the same workflow text the MCP server serves as `brain://workflow`, so the text now lives in core and both use it. The skill's description tells Claude Code when to load it.
- **Dogfood.** Phase 2 was tracked in brain itself: every checklist item was a brain task, claimed before work and completed with a summary and files. This repo now has the rules block in `AGENTS.md`, `@AGENTS.md` in `CLAUDE.md`, the MCP entry in `.mcp.json`, and the hooks and skill under `.claude/`, all written by `brain rules sync`.

### Verify output (local, 2026-11-03, macOS, Node 26.12.1)

```
$ pnpm lint && pnpm typecheck && pnpm test
 Tasks:    7 successful, 7 total
@brain/core:test:       Tests  83 passed (83)
@brain/core:test: All files      |   98.08 |    90.23 |   95.68 |   99.11 |
@brain/store-sqlite:test:       Tests  24 passed (24)
@brain/mcp:test:       Tests  10 passed (10)
@scope/brain:test:       Tests  36 passed (36)
 Tasks:    8 successful, 8 total
```

Brief size: the core test "stays under the token cap on a large project" checks the 1,500-token cap
on a large fixture. In this repo, `brain brief --json` reports 54 tokens (agent and short formats).

The Stop hook against this repo's DB while holding a claim:

```
$ echo '{"hook_event_name":"Stop","stop_hook_active":false}' | brain nudge
{"decision":"block","reason":"You still hold tsk_e25mwf (Claude Code hooks: SessionStart brief (startup, compact, resume) and Stop nudge). If the work is finished, call task_complete with a summary and the files touched; otherwise call task_update with its status and a note."}
```

### Gate remaining

- **Claude Code and Codex each finish a real task using only brain tools.** This needs a person to
  start fresh sessions in each tool, with `brain` on PATH, in a project set up by `brain init`. The
  automated MCP tests cover the same flow (brief, list, claim, update, complete) through a real
  client over the SDK's in-memory transport, but they are not the gate.
- **Waived 2026-11-03 by the user.** Phase 3 starts before these runs. The gate is still owed:
  run it once the Phase 3 tools exist, so the rules block no longer names missing tools.

### Fixes after the checklist

- `brain init` and `brain rules sync` warn on stderr when `brain` is not on PATH, because the MCP
  config and hooks start it by name and would otherwise fail without a message (for example after
  `npx ... init`). JSON output is unchanged.
- A `.claude/settings.json` whose `hooks` setting is malformed now stops with a VALIDATION error
  instead of crashing the merge.

## Phase 3 — Coordination

Status: in progress.

### Claims with leases and heartbeats

- The claim check-and-set already ran in one `BEGIN IMMEDIATE` transaction (Phase 1). New here: a
  test that starts 20 `brain task claim` processes on one task. Exactly one wins, 19 get CONFLICT
  (exit 4), and none see `SQLITE_BUSY`. With a deferred `BEGIN` the same test fails, so it guards
  the lock mode.
- Heartbeats: choice on an ambiguous item. "Any write by the holder" is read as any write the
  holder makes to the claimed task (update, or claiming again to renew). Writes to other records
  do not renew it. Lock writes can renew claims when locks land, if needed.
- Expired leases: `releaseExpiredClaims` clears them, as PLAN asks of every brief. It runs at the
  start of `buildBrief` and writes only when something expired. Choice: an expired `in_progress`
  task goes back to `todo`, so it shows up as ready again. `review` and `blocked` tasks keep their
  status and only lose the claim. Each release logs a new activity verb, `release`.
- `brain doctor` does not exist yet; it should call the same service when it is added.

### Path locks

- `brain lock acquire|release|list`, MCP `lock_acquire` and `lock_release`. The overlap check and
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

- `brain guard --staged` checks the staged diff (`git diff --cached --no-renames`, with removed
  line counts and the `HEAD` line count of each modified file). `brain guard --paths a,b` checks
  paths as edits. MCP `feature_check` takes paths and `modify` or `delete`. Exit 10 (BLOCKED)
  when anything is blocked; warnings exit 0.
- Rules, as in the PLAN: another actor's exclusive lock blocks (a shared one warns). Deleting a
  file of a shipped, protected feature blocks, and so does removing more than half of its lines
  (`guard.maxRemovalRatio` in `brain.config.json`). Any Decision listing the feature turns those
  into warnings that name the decision; the newest one wins. Any other change to a shipped
  feature warns. Features not shipped are ignored.
- Removal share (choice on an ambiguous item): removed lines over base lines across the
  feature's changed files, not the whole feature. Files with no counts (binary, or `--paths`) are
  left out. A deleted file counts as fully removed.
- Logging: staged mode writes one `guard` activity row per finding. `--paths`, the hook and
  `feature_check` are read-only, except that a blocked run let through by `BRAIN_GUARD=off`
  always writes its rows with `override: true` and the actor.
- Renames show as a delete plus an add, which errs towards blocking, until the rename item.
- `brain init` installs `.git/hooks/pre-commit` (found with `git rev-parse --git-path hooks`) in
  git and stealth modes. It runs `brain guard --staged` if `brain` is on PATH, and otherwise
  warns and lets the commit through. An existing hook is never overwritten: it is reported as
  `keep` if it already runs the guard and `skip` otherwise. Chaining with husky or lefthook is a
  later item.
- The Claude Code hook is `PreToolUse` on `Edit|MultiEdit|Write|NotebookEdit`, running
  `brain guard --hook`, which reads the tool input from stdin. Blocked exits 2 with the reason
  on stderr, so Claude Code stops the edit and shows the reason. Warnings go to stdout as
  `hookSpecificOutput.additionalContext` (assumed from the hook docs; not checked against a live
  Claude Code). Errors exit 1 so a broken brain never blocks edits. Paths outside the repo pass.
- `init` used to write the config JSON into every created file before the agent files replaced
  it. It now writes only the config entry.

### Export / import

- New package `packages/sync` (`@brain/sync`, bundled into the CLI like the others). It holds
  the file I/O, so `core` stays free of I/O: core only has `snapshotRecords` and
  `importRecords`. This grew the item by one package.
- Export writes `.brain/<plural>/<id>.json` for milestones, features, tasks, decisions, notes
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
- `brain sync export|import` work only in git mode. Stealth and standalone commit nothing, so
  they exit with USAGE.
- Debounce: `brain mcp` in git mode exports 2 s after the last write, and once more on
  shutdown. CLI write commands do not export; the pre-commit hook covers commits. Export errors
  go to stderr and never fail the write.
- Hooks: `brain init` writes `pre-commit` (guard, then `brain sync export` and
  `git add -A -- .brain`) and `post-merge`, `post-checkout`, `post-rewrite`
  (`brain sync import`) in git mode. Stealth gets the guard-only pre-commit. A hook carrying the
  "Installed by `brain init`" header is ours and is updated; any other existing hook is skipped.
  Every hook warns and exits 0 when `brain` is not on PATH.
- Caveat: `git add` inside pre-commit also stages `.brain/` on a partial commit
  (`git commit <path>`). That is the intended snapshot, but it is a side effect worth knowing.

### Merge driver

- `brain merge-driver %O %A %B` merges one `.brain/` record file and writes the result over
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
- `brain init` in git mode appends `.brain/**/*.json merge=brain` to `.gitattributes` (other
  lines kept) and sets `merge.brain.name` / `merge.brain.driver` in the local git config. The
  driver is found by name on PATH; recording an absolute path is the later security item.
- Property tests (fast-check, 2000 runs each): merge is deterministic; it is symmetric when no
  field clashes; no one-sided change or added label is lost; separate line edits merge cleanly.
  An end-to-end test merges two branches through git and the post-merge import.
- Found while testing: a commit that changes only records (`git commit -a` with no tracked
  file changed) stops with "nothing to commit". git decides that before the pre-commit hook
  stages the snapshot. Commits that also change code are fine. Workaround: `brain sync export`
  and `git add .brain` first. Not fixed in this item.

### Context cache

- `brain context put <path> --summary … [--key-files …]` and `brain context get [path]`, plus
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
PASS  CLI cold start (brain --version), p95               61.9 ms  (budget 80 ms)
PASS  CLI read command, p95                              139.2 ms  (budget 150 ms)
PASS  Full-text search on 50000 records, p95              32.4 ms  (budget 50 ms)
PASS  task_claim under 10 concurrent agents, p95           3.3 ms  (budget 50 ms)
```

The CLI read p95 is close to its budget and varies with machine load (one run on a busy machine
measured 233 ms on a tiny DB). Watch it in CI.
