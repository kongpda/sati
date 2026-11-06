# Handoff

Updated 2026-11-07 on `codex/local-production-checkpoint` (PR #2). `PLAN.md` is the spec.
`docs/progress.md` records the choices. Tick a box in `PLAN.md` in the same commit as the code.

## Where things stand

- Phases 0–5: every checklist item that code can close is done. The boxes still open need the
  owner or a person (see below).
- Phase 3 gate: `packages/cli/test/e2e.test.ts` runs four agents in four worktrees. CI runs 10
  seeds on each push. The 100-run job only runs from `main` (`schedule` and
  `workflow_dispatch`), so the gate closes after PR #2 merges and that job passes.
- Phase 4 gate: `pnpm test:ui` (Playwright, axe, 2,000-card board) passes and runs in CI. Mermaid
  renders with `pele`, lazy-loaded.
- Phase 5: docs in `docs/guide/` (quick start, agent workflow, guard rules, FAQ).
  `packages/core/src/workflow.ts` is generated from `docs/guide/agent-workflow.md` by
  `pnpm --filter @sati/core gen:workflow`; a test fails when the two drift. `SECURITY.md`,
  `renovate.json`, `pnpm audit` in CI and the importer fuzz are in.
- Phase 6 (hosted Postgres, Better Auth, remote sync, remote MCP) is not started. Do not fake
  it. Ask the owner before starting, and pick a real host first.

## Branches and PRs

- PR #2 `codex/local-production-checkpoint`: all the work since `main` (`dbd236b`). Merge it
  when CI is green.
- PR #1 `changeset-release/main` ("Version Packages"): merging it publishes to npm. Only the
  owner merges it, after the items below.

## How to work

1. One checklist item at a time, top to bottom. One conventional commit per item.
2. Run `pnpm build`, then `pnpm lint && pnpm typecheck && pnpm test`, before each commit. CLI
   tests execute `packages/cli/dist/index.mjs`, so rebuild first. `pnpm test:ui` and
   `pnpm test:e2e` are the slower suites.
3. Track the item in sati: `task create`, `task claim`, then `task complete` with the files.
4. Core stays strict TypeScript, Zod on inputs, one `store.write` plus an activity row.
   The product name stays in `packages/core/src/name.ts` (`CLI_NAME`).
5. A test should say why (`// PLAN:`) and fail when the rule breaks.
6. Never use `--no-verify`. Never edit `.sati/` by hand. Stack changes need an ADR and a yes.
   Ideas that are not in the plan go in `docs/ideas.md`.
7. Tests must pass on Linux, macOS and Windows. Compare paths with `/` (`shownPath`), use
   `path.delimiter` for PATH, and skip file-mode checks on Windows.

## Owed by the owner

- Final product name and npm scope (PLAN 420, 626).
- npm two-factor and the first provenance publish (PLAN 382, 419), then merge PR #1.
- Licence. `packages/cli/package.json` says `UNLICENSED` (PLAN 627).
- Open decisions in PLAN 628–630: snapshot export on every branch, default lock mode, hosted
  pricing.
- A week on three real projects, one of them a stealth-mode client repo (PLAN 542).
- The manual keyboard and screen-reader pass (PLAN 528). axe is clean and in CI.
- Install the Renovate GitHub app and turn on GitHub private vulnerability reporting.
- The repository is private, so the docs links in the npm README (`packages/cli/README.md`)
  will not open for npm users until it is public or the docs move elsewhere.

## Production bar for Phase 6

These acceptance bars are already in `PLAN.md`:

- **Performance.** CLI cold start under 80 ms, read p95 under 150 ms, claim under 50 ms,
  search under 50 ms. UI first load under 1 s and under 250 KB gzipped. A 2,000-card board
  stays at 60 fps.
- **Security.** Better Auth, hashed scoped tokens, `orgId` on every query with row-level
  security, rate limits, TLS, encrypted backups, secrets from the environment.
- **Already met locally.** `127.0.0.1` bind, `HttpOnly` `SameSite=Strict` cookie, Host and
  Origin checks, CSP `default-src 'self'`, no raw HTML in Markdown, secret scan on export,
  merge driver parses JSON only, hooks call an absolute binary path, guard overrides and forced
  lock releases are logged.
