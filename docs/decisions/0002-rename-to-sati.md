# 0002. Rename the product to sati

- Status: accepted
- Date: 2026-11-03

## Context

The product shipped under the placeholder name `brain` (package `@scope/brain`). The owner chose
the name `sati` and the npm scope `@kongpda`. Nothing is published yet (version 0.0.0), and the
only installed project is this repository.

## Decision

Rename everything at once, with no compatibility layer:

- `name.ts`: `PRODUCT_NAME` and `CLI_NAME` are `sati`; `PACKAGE_NAME` is `@kongpda/sati`.
- The binary is `sati`. Workspace packages are `@sati/core`, `@sati/mcp`, `@sati/sync` and
  `@sati/store-sqlite`.
- The committed folder is `.sati/` with `sati.config.json`. The git-mode DB is
  `<git-common-dir>/sati/sati.db`; the standalone DB is `~/.sati/projects/<projectId>.db`.
- Environment variables use the `SATI_` prefix (`SATI_ACTOR`, `SATI_GUARD`, `SATI_DEBUG`,
  `SATI_SESSION_ID`, `SATI_BIN_DIR`). The MCP server, its `sati_brief` tool and the
  `sati://` resources, the managed rules block markers and the Claude Code skill use `sati`.
- Code identifiers follow: `SatiError`, `SatiConfigSchema` and so on.

This repository was migrated by hand: `git mv .brain .sati`, the DB copied with SQLite's
`.backup` from `.git/brain/brain.db` to `.git/sati/sati.db`, and `.mcp.json`,
`.claude/settings.json` and the skill rewritten. The old `.git/brain/` is kept as a backup.

## Consequences

- No other project has data under the old names, so nothing else needs migrating. A project
  set up with `brain` before this change would need the same manual steps.
- Records already in the DB keep their text, including the project name "Agent Brain". There
  is no command to rename a project yet.
- Running agent sessions must restart to pick up the renamed MCP server and hooks.

## Alternatives considered

- Keep reading `.brain/`, `BRAIN_*` and the old DB path as fallbacks. Rejected: no published
  users, and the fallbacks would be code to keep and test for nobody.
- Rename only the package and binary. Rejected: the folder, env vars and tool names would carry
  a name the product no longer uses.
