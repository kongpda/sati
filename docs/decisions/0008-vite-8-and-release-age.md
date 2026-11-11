# 0008. Vite 8, and no dependency version younger than 14 days

- Status: accepted (2026-11-11, owner asked for the remaining updates)
- Date: 2026-11-11

## Context

`renovate.json` asks for an ADR before a major update and for a minimum release age of 14 days.
No Renovate PR has run yet, so updates are made by hand. A first hand update on 2026-11-11
(commit `cc73aea`) took the newest versions, some published days or hours earlier. That broke
the 14-day rule and was corrected in the next commit.

## Decision

- The board builds with `vite` 8 and `@vitejs/plugin-react` 6. `vite.config.ts` needed no change.
  The unit tests and the 89 Playwright tests pass on the new build.
- A hand update pins the newest version that is at least 14 days old, the same rule Renovate
  follows. Packages already at a younger version (pinned before this ADR) stay where they are.
- `@types/node` stays at 24 while Node 24 is the minimum: newer types allow APIs it lacks.

## Not done

`minimumReleaseAge` in `pnpm-workspace.yaml` would enforce the rule for transitive packages
too. Tried on pnpm 10.18: it dropped the platform binaries of packages the lockfile already
held at 13 days old (`@biomejs/biome`, `rolldown`), and the build failed. Try again once every
pinned package is older than 14 days.
