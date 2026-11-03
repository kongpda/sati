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

Status: in progress.

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
