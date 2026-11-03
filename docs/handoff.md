# Handoff: what is not done yet

Written 2026-11-03 after commit `002e9a0` (context cache). This file is for the next agent picking
up the work. `PLAN.md` is the spec and `docs/progress.md` records every choice made so far; read
both before starting. Keep this file current: tick items here and in `PLAN.md` in the same commit.

## Where things stand

- Phases 0–2: done, except the items under "Owed by the owner" below.
- Phase 3: 6 of 19 checklist items done (claims and leases, path locks, guard, export/import and
  hooks, merge driver, context cache). 13 items and the Phase 3 gate remain.
- Phases 4–6 and the Security checklist: not started (two Security items are met; see below).
- All checks pass at `002e9a0`: lint, typecheck, and 256 tests (core 143, CLI 55, store 26,
  sync 19, MCP 13). Core coverage: 98.4% statements, 92% branches (threshold 90%).

## How to work (rules that are easy to miss)

- [ ] Read `AGENTS.md` and `AGENT_KICKOFF.md`. One checklist item at a time, top to bottom.
- [ ] Run commands through `rtk proxy` (plain `pnpm biome` through the rtk hook prints a bogus
      "terminated abnormally" error):
      `rtk proxy pnpm biome check --write .`, then `rtk proxy pnpm lint`,
      `rtk proxy pnpm typecheck`, `rtk proxy pnpm test`. Rebuild (`rtk proxy pnpm build`) before
      CLI tests: they run `packages/cli/dist/index.mjs`.
- [ ] Track each item in brain itself:
      `id=$(brain task create "…" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')`,
      `brain task claim $id`, then before the commit
      `brain task complete $id --summary "…" --files a,b`.
- [ ] One conventional commit per item; tick `- [x]` in `PLAN.md` in that commit; add a
      `### <item>` section to `docs/progress.md` (before "### Fix: full-index scan…") listing
      choices made on ambiguous points.
- [ ] Core: strict TS, no `any`, Zod on every input, every write in one `store.write`
      transaction plus an activity row (`insertWithLog` / `updateWithLog` / `logActivity`).
      Core does no I/O: git and file access come in through ports (`ports/repo.ts` is the
      newest example) or as input data (the guard takes a change list).
- [ ] The product name lives only in `packages/core/src/name.ts`; use `CLI_NAME`, never the
      literal `brain`, in code and generated text.
- [ ] Tests explain why (a `// PLAN:` comment) and should fail when the rule breaks. Mutate the
      key line once to prove it.
- [ ] Never use `--no-verify`; never edit `.brain/` by hand; stack changes need an ADR in
      `docs/decisions/` and the owner's approval; ideas outside the plan go in `docs/ideas.md`.

## Phase 3: remaining checklist items, in order

### 1. Secret scanner on export

- [ ] Before `exportSnapshot` (`packages/sync/src/snapshot.ts`) writes any file, scan every
      string field of every record for secrets: API keys and tokens (AWS `AKIA…`, GitHub
      `ghp_`/`github_pat_`, Slack `xox…`, `sk-…`, JWTs), PEM private-key headers, and
      `.env`-style `NAME=value` lines whose name looks secret (`*_KEY`, `*_TOKEN`, `*SECRET*`,
      `PASSWORD`).
- [ ] Refuse the whole export with a clear error naming the entity id and field (never print the
      secret itself). PLAN Security says "refuse with a clear message".
- [ ] Decide and record: does a refused export also fail the pre-commit hook? (Simplest: yes,
      the hook runs `brain sync export && git add`, so a non-zero exit blocks the commit.)
- [ ] The MCP debounced export (`packages/cli/src/commands/mcp.ts`) must report the refusal on
      stderr and keep serving.
- [ ] Tick the Security item "Scan every exported record for secrets" too.

### 2. Fencing tokens (review fix 2)

- [ ] `claimTask` (`packages/core/src/services/task.ts:148`) returns a token that changes on
      every new claim (for example a counter stored on `task.claim`). Schema: `Task.claim` in
      `packages/core/src/domain/schemas.ts`.
- [ ] `updateTask` and `completeTask` (lines 95 and 125) take the token; a stale or missing
      token from the claim holder fails with CONFLICT. Decide what non-holders get (they are
      already refused while a lease is live).
- [ ] Wire through: MCP `task_claim` / `task_update` / `task_complete`
      (`packages/mcp/src/server.ts`), CLI `brain task claim|update|complete`
      (`packages/cli/src/commands/task.ts`, e.g. `--token`), and the workflow text
      (`packages/core/src/workflow.ts`, rules in `domain/rules.ts`; bump the rules block
      version if the managed text changes).
- [ ] Test the point of fencing: agent A's lease expires, B claims, A's late write is refused.

### 3. Hybrid logical clock stamps (review fix 3)

- [ ] Replace `updatedAt` ordering in the merge driver (`packages/sync/src/merge.ts`,
      `newer` and the tie break) with per-field HLC stamps.
- [ ] Needs a stored stamp per field (for example `stamps: Record<field, hlc>` in the record
      JSON; no migration since entities are a JSON `data` column) set by `updateWithLog` in
      `packages/core/src/services/context.ts`, and an HLC in core (`ports/clock.ts` has the
      wall clock).
- [ ] Records without stamps (written before this item) must still merge: fall back to
      `updatedAt`.
- [ ] Keep the existing property tests passing; add one where clock skew (a clone whose wall
      clock is behind) would have picked the wrong side with `updatedAt`.

### 4. Delete-vs-edit rule (review fix 4)

- [ ] In `mergeRecord`, when one side set `deletedAt` and the other edited other fields: if the
      edit is newer (by HLC once item 3 lands), clear `deletedAt` and set `needsReview`;
      otherwise the delete wins. Today the delete always wins (documented in progress.md
      "### Merge driver").
- [ ] Add a property test for both outcomes.

### 5. Hook installer chains into existing managers (review fix 5)

- [ ] `planHooks` in `packages/cli/src/hooks.ts` uses `git rev-parse --git-path hooks`, which
      already follows `core.hooksPath`, but foreign hooks are skipped. Detect husky
      (`.husky/`), lefthook (`lefthook.yml`) and a custom `core.hooksPath`, and add the brain
      lines to their config instead of skipping. Never overwrite.
- [ ] `brain init` must show each change before applying it (it prints a plan already).

### 6. Guard rename detection (review fix 6)

- [ ] `packages/cli/src/commands/guard.ts` / `packages/cli/src/git.ts` read the staged diff
      with `--numstat`; add `-M` so a rename is not a delete plus an add (today it errs towards
      blocking; see progress.md "### Guard").
- [ ] Core `checkChanges` (`packages/core/src/services/guard.ts`) needs a `renamed` kind with
      the old path. Offer to update feature `paths` (CLI prompt or a hint with the
      `brain feature update` command; pick the simplest and record it).

### 7. Feature globs matching zero files (review fix 7)

- [ ] `brain doctor` does not exist yet (Phase 5). Simplest reading: add the check to the brief
      now (needs the `repo` port's file list, like the stale-context section in
      `packages/core/src/services/brief.ts`) and leave doctor to Phase 5. Record the choice.

### 8. PreToolUse matches Bash (review fix 8)

- [ ] The Claude Code hook (written by `packages/cli/src/integrations.ts`, handled by
      `brain guard --hook`) matches `Edit|MultiEdit|Write|NotebookEdit`. Add `Bash` and parse
      `rm`, `git rm`, `mv` (with flags, multiple paths, `&&` chains) into delete/rename
      changes for `checkChanges`. Unknown commands pass.
- [ ] Existing installs get the new matcher through `brain init` / `brain rules sync` (check
      which one rewrites `.claude/settings.json`).

### 9. Network filesystems and daemon mode (review fix 9)

- [ ] Detect NFS/SMB and Docker/WSL bind mounts for the DB path
      (`packages/store-sqlite/src/locate.ts`); SQLite locking is unsafe there.
- [ ] Fallback is a daemon: `brain serve` owns the DB and other processes talk to it over a
      local socket. This is large (a new transport behind `StorageAdapter`); tell the owner
      about the size before starting, per the global "keep effort proportional" rule.

### 10. pre-push hook and CI guard (review fix 1)

- [ ] Add a `pre-push` hook running `brain guard --range origin/main...HEAD` (the `--range`
      flag is new on `brain guard`).
- [ ] Add a GitHub Actions example (docs, and optionally `.github/workflows/`) running the same
      command, so `--no-verify` commits are still caught.
- [ ] Add a Claude Code deny rule for `git commit --no-verify` in the settings `brain init`
      writes.

### 11. `.gitattributes` `linguist-generated`

- [ ] Change `ATTRIBUTE` in `packages/cli/src/hooks.ts` to
      `.brain/**/*.json merge=brain linguist-generated`. `planGitAttributes` must then replace
      the older line in place instead of appending a second one. Update
      `packages/cli/test/init.test.ts`.

### 12. `brain handoff`

- [ ] A structured "where I stopped" note on a task: done so far, next step, open questions,
      files in flight. Store it on the task (or as a linked note; pick the simplest and record
      it), expose it as a CLI command and in the brief for whoever claims the task next.
      PLAN lists 14 MCP tools, which are all registered now; adding a tool needs a note in
      progress.md.

### 13. E2E scenario and the Phase 3 gate

- [ ] `e2e/`: 4 agents in 4 git worktrees, random claims, locks and merges for 1,000 steps;
      assert zero duplicate claims and zero lost records.
- [ ] Add `pnpm test:e2e` with `--repeat`, and the guard fixtures in `e2e/guard/`.
- [ ] Gate: the scenario passes 100 runs in CI; a staged delete of a protected feature is
      blocked; a `--no-verify` commit is caught by the CI guard.

## Known gaps found along the way (not checklist items)

- [ ] **Record-only `git commit -a` fails.** If only brain records changed, git says "nothing
      to commit" before the pre-commit hook stages the snapshot. Commits that also change code
      work. Workaround: `brain sync export && git add .brain` first. Possible fix: export on
      CLI writes (like the MCP debounce), so `.brain/` is already dirty. Needs an owner
      decision. See progress.md "### Merge driver".
- [ ] **`needsReview` is never cleared.** Set by the merge driver; no command clears it yet.
      The UI (Phase 4) or a `task update` flag could; record the choice.
- [ ] **Merge driver found by name on PATH.** Hooks and the driver call `brain` by name. The
      Security item "Hooks call the installed `brain` binary via an absolute path recorded at
      init" is open.
- [ ] **This repo's own hooks and merge driver are not installed.** `brain init` does not
      re-run on an initialised project, so `.git/hooks` here predate the sync hooks and the
      merge driver. Decide whether `brain init` (or `brain rules sync`) should upgrade them.
- [ ] **Context staleness sees staged content only** (`git ls-files -s`): unstaged edits and
      untracked files do not mark an entry stale. Documented as a choice.
- [ ] **Brief deferrals** (progress.md, Phase 2 section): "changes since my last session"
      needs a per-actor session marker the plan does not define.

## Security checklist

- [x] "Never store file contents in context entries": met by the context cache design.
- [x] "The merge driver only parses JSON": met (`parseRecord` in `merge.ts`).
- [ ] Everything else in the Security section is open; most of it belongs to Phases 4–6.

## Owed by the owner (do not do these yourself)

- [ ] Phase 2 gate: Claude Code and Codex each finish a real task using only brain tools (waived
      on 2026-11-03, still owed).
- [ ] Product name (placeholder `brain` / `@scope/brain` stays until then), npm scope,
      two-factor and provenance publishing (Phase 0 items on PLAN lines 418–419).
- [ ] `pele` licence check before Phase 4 uses it for Mermaid rendering.
- [ ] First CI run: there is no GitHub remote yet, so `.github/workflows/ci.yml` has never run.

## After Phase 3

Phase 4 (web UI), Phase 5 (hardening, `brain doctor`, v1.0) and Phase 6 (hosted) are untouched.
Their checklists in `PLAN.md` are the task list; do not start them before the Phase 3 gate.
