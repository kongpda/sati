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
