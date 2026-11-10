# Contributing

## Dev setup

You need Node.js 24.15 or later and pnpm.

```bash
pnpm install
pnpm build          # the CLI tests and the board tests run packages/cli/dist
pnpm lint && pnpm typecheck && pnpm test
```

Before the first `pnpm test:ui` (the Playwright tests in `e2e/ui`), install the browser:

```bash
pnpm --filter @sati/e2e exec playwright install chromium
pnpm build && pnpm test:ui
```

This repo tracks its own work in sati. The committed `.claude/settings.json` and `.mcp.json` call
`sati` from `PATH`, so put your build there with `pnpm local` (`scripts/local.sh`). It builds,
checks and links `sati` into `~/.local/bin`; `pnpm local --fast` skips the checks.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`.

- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`.
- Scopes: package names without prefix (`core`, `store-sqlite`, `sync`, `mcp`, `ui`, `cli`), or `release`, `e2e`.
- One checklist item per commit where possible.

## Changes users see

Add a changeset: `pnpm changeset`. Releases publish from GitHub Actions only, with npm provenance.

## Decisions

Record any change to the stack or architecture as an ADR. Copy `docs/decisions/0000-template.md` to `docs/decisions/NNNN-short-title.md`, numbered in order.

## Before you push

```bash
pnpm lint && pnpm typecheck && pnpm test
```
