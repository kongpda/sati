# AGENTS.md

This repo builds **Agent Brain** (`brain`). The full spec is in `PLAN.md`; how to work is in `AGENT_KICKOFF.md`.

## Rules

- Work one phase at a time, in order. Do not start a phase until the previous Gate passes.
- Work the checklist in `PLAN.md` top to bottom. Tick `- [x]` in the same commit as the work.
- Run `pnpm lint && pnpm typecheck && pnpm test` before every commit.
- Strict TypeScript, ESM only, no `any`. Validate all inputs with Zod.
- Every write in `core` runs in one transaction and writes an activity row.
- Follow the tech stack in `PLAN.md`. To change it, write an ADR in `docs/decisions/` and ask first.
- No features outside `PLAN.md`. Put ideas in `docs/ideas.md`.
- The product name lives only in `packages/core/src/name.ts`.

## Layout

- `packages/core` — domain, services, ports. No I/O.
- `packages/cli` — the `brain` binary, published as `@scope/brain`.
- `docs/progress.md` — gate results and choices made on ambiguous items.
- `docs/decisions/` — architecture decision records.

## Commands

```bash
pnpm install
pnpm build
pnpm lint && pnpm typecheck && pnpm test
pnpm changeset   # describe a user-facing change
```

From Phase 2 onward this repo is tracked in brain itself; a managed rules block will be added below.
