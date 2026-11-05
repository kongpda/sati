# Handoff

Updated 2026-11-04 on `main` (`dbd236b` plus uncommitted work). `PLAN.md` is the spec.
`docs/progress.md` records the choices. Tick a box in `PLAN.md` in the same commit as the code.

## Where things stand

- Phases 0–2: checklist done. Phase 0 gate still needs a human (name, npm 2FA, a real publish).
  Phase 2 gate is still the owner's Claude Code and Codex session.
- Phase 3 and 3b: implemented, except the 4-worktree e2e gate. `sati serve` owns the database
  on a network or bind-mount filesystem. `sati handoff`, `sati next`, the review gate, plan
  import, delete/restore, the personal workspace, activity and undo are in the CLI.
- Phase 4: the local board is up. The roadmap is a date timeline. Notes have a Markdown field,
  a preview and backlinks. Still open: Mermaid via `pele` (licence), Playwright, axe, and the
  2,000-card frame budget.
- Phase 5: `sati doctor`, `sati export --all` / `sati import`, migration backups, `sati review`
  and `sati scan` are in. Still open: the docs site, importer fuzz, and a week on three real
  projects.
- Phase 6 (hosted Postgres, Better Auth, remote sync) is not started. Do not fake it.

`origin/changeset-release/main` is `main` plus `c704d54` ("Version Packages"), which bumps
`@kongpda/sati` to `0.0.1`. It is not merged. There is no other branch.

## How to work

1. One checklist item at a time, top to bottom. One conventional commit per item.
2. Run `pnpm lint && pnpm typecheck && pnpm test` before that commit. Rebuild before CLI tests
   that execute `packages/cli/dist/index.mjs`.
3. Track the item in sati: `task create`, `task claim`, then `task complete` with the files.
4. Core stays strict TypeScript, Zod on inputs, one `store.write` plus an activity row.
   The product name stays in `packages/core/src/name.ts` (`CLI_NAME`).
5. A test should say why (`// PLAN:`) and fail when the rule breaks.
6. Never use `--no-verify`. Never edit `.sati/` by hand. Stack changes need an ADR and a yes.
   Ideas that are not in the plan go in `docs/ideas.md`.

## Still open, in order

- **E2E gate.** Four git worktrees, 1,000 random steps, merges, zero duplicate claims, zero
  lost records, repeated 100 times. `pnpm test:e2e` today runs a single-process stand-in
  (`packages/core/test/loop.test.ts`). The CI guard job in `.github/workflows/ci.yml` already
  runs `sati guard`.
- **Phase 4 measurements and licence.** Playwright, axe, the 2,000-card 60 fps check, and
  Mermaid through `pele` after the licence is checked. The notes editor is a Markdown field.
- **Phase 5 remainder.** A docs site whose text also feeds `sati://workflow`, and a fuzz of
  the JSON importer. `SECURITY.md`, Renovate, and `pnpm audit` in CI are still open.
- **Phase 6.** Hosted Postgres, Better Auth, org isolation, remote MCP, the multi-project
  dashboard. Leave these until there is a real host.

### Production bar for the later phases

Do not start these until the gates above pass. When they start, these are the acceptance bars
already written in `PLAN.md`:

- **Performance.** CLI cold start under 80 ms, read p95 under 150 ms, claim under 50 ms,
  search under 50 ms. Last local run (2026-11-03) passed, with the read close to its budget.
  UI first load under 1 s and under 250 KB gzipped. A 2,000-card board stays at 60 fps.
- **UX.** Keyboard-first, light and dark from the system, WCAG 2.2 AA, 375 px, Khmer-capable
  fonts, optimistic updates, empty states that name the command to run. Terminal output is
  coloured only on a TTY, `--json` for machines, and errors name the next command.
- **Security.** Local server binds `127.0.0.1`, session cookie is `HttpOnly` and
  `SameSite=Strict`, Host and Origin are checked, CSP is `default-src 'self'`. Markdown has
  no raw HTML. Hosted mode is Better Auth, hashed scoped tokens, `orgId` on every query,
  rate limits, TLS. `SECURITY.md` and `pnpm audit` in CI are still open.
- **Already met.** Secret scan on export, no file contents in context, merge driver parses
  JSON only, hooks call an absolute binary path, FTS terms are quoted, Drizzle uses
  parameters, guard overrides and forced lock releases are logged, `sati init` shows a
  preview and asks.

## Owed by the owner

- Final product name, npm scope, npm two-factor, and the first provenance publish.
- Phase 2 gate: Claude Code and Codex each finish a real task using only sati tools.
- `pele` licence check before Phase 4 renders Mermaid with it.
- Licence choice, hosted pricing, and a week on three real projects (Phase 5).
