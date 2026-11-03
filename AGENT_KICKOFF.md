# Agent kickoff: build Agent Brain

You are building **Agent Brain**, a local-first memory, task and feature manager for AI coding agents, published to npm. The full specification is in `PLAN.md`. Read it fully before writing any code.

> Working name: `brain` (CLI) and `@scope/brain` (package). The final name is not chosen yet. Use `brain` everywhere and keep the name in one constant (`packages/core/src/name.ts`) so a rename is a one-line change plus a search-and-replace.

## How to work

1. **One phase at a time, in order** (Phase 0 → 6). Do not start a phase until the previous phase's **Gate** passes.
2. **Work the checklist top to bottom.** After finishing an item, change its `- [ ]` to `- [x]` in `PLAN.md` and commit both together.
3. **Small commits.** Use conventional commits: `feat(core): …`, `fix(sync): …`, `test(e2e): …`. One checklist item per commit where possible.
4. **Tests come with the code.** Never tick an item whose tests are missing or failing. Run `pnpm typecheck && pnpm lint && pnpm test` before each commit.
5. **At each Gate:** run the Verify commands, paste the output into `docs/progress.md` under the phase heading, and stop to report a summary to the human before starting the next phase.
6. **From Phase 2 onward, dogfood.** Track the remaining work in brain itself (`brain task create` for each checklist item) and follow the rules block it installs.

## Rules

- Follow the stack in "Tech stack" exactly. If you believe a choice is wrong, write a decision record in `docs/decisions/NNNN-title.md` and ask before switching.
- Strict TypeScript, ESM only, no `any` outside generated code. All inputs are validated with Zod.
- Every write path in `core` runs in one transaction and writes an activity row.
- Meet the budgets in "Performance budgets"; add a benchmark when you add a hot path.
- Treat every item in "Security" as a requirement, not a suggestion.
- Do not add features that are not in `PLAN.md`. Put ideas in `docs/ideas.md`.
- If a checklist item is ambiguous, pick the simplest reading that satisfies the Gate, note the choice in `docs/progress.md`, and continue.

## Start now

Begin Phase 0. Your first message back should list the files you will create for Phase 0 and the open questions (if any) that block it.
