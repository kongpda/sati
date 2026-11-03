# Contributing

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`.

- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`.
- Scopes: package names without prefix (`core`, `cli`, `sync`, `mcp`, `server`, `ui`), or `release`, `e2e`.
- One checklist item per commit where possible.

## Changes users see

Add a changeset: `pnpm changeset`. Releases publish from GitHub Actions only, with npm provenance.

## Decisions

Record any change to the stack or architecture as an ADR. Copy `docs/decisions/0000-template.md` to `docs/decisions/NNNN-short-title.md`, numbered in order.

## Before you push

```bash
pnpm lint && pnpm typecheck && pnpm test
```
