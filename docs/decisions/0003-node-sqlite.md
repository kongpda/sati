# 0003. Replace better-sqlite3 with Node's built-in node:sqlite

- Status: accepted (2026-11-08)
- Date: 2026-11-07

## Context

`npm install @kongpda/sati` installs 56 MB in 106 packages, measured on 2026-11-07 by
installing the packed CLI into an empty project. PLAN's budget is under 15 MB. One package,
the native `better-sqlite3`, is 27 MB of that: the SQLite source, a compiled addon and its
build files. The next largest are `zod` (8 MB) and `@modelcontextprotocol/sdk` (7 MB).

The native addon also brings install risk. PLAN lists "native `better-sqlite3` fails to install
on some machines" as a risk. A prebuilt binary must exist for each platform and Node ABI;
without one, install falls back to compiling, which needs a C++ toolchain.

PLAN rejected `node:sqlite` on 2026-11-03 with "revisit once stable". Its status has moved
since:

| Node | Stability of `node:sqlite` | Warning on import |
| --- | --- | --- |
| 22 (maintenance LTS) | 1.1, active development | Yes: `ExperimentalWarning` on stderr |
| 24 (LTS) | 1.2, release candidate since 24.15 | No |
| 26 (active LTS since 2026-10-28) | 1.2, release candidate | No |

Sources: the Node.js `sqlite` docs (history: "v25.7.0: SQLite is now a release candidate")
and runs on Node 22.23.4, 24.22.2 and 26.12.1 in this orb.

What the store uses, checked on all three versions with a probe script: WAL journal mode,
`busy_timeout` (the `timeout` constructor option), `user_version`, `data_version` changing
after another connection writes, read-only open, `integrity_check`, `optimize`, FTS5 with
`bm25` weights, JSON functions, `rowid` (the activity cursor), explicit `BEGIN IMMEDIATE`,
`isTransaction`, and online backup (`backup()` from `node:sqlite`). All work. Node bundles
SQLite 3.53.4 (22, 24) and 3.54.0 (26).

A micro-benchmark on Node 26 (20,000 rows, WAL, synchronous NORMAL; the second of two runs):

| | better-sqlite3 | node:sqlite |
| --- | --- | --- |
| Insert 20,000 rows in one transaction | 54 ms | 39 ms |
| 20,000 prepared point reads | 68 ms | 79 ms |
| 200 single-row write transactions | 4 ms | 4 ms |
| Process start, import, open, one query | 40 ms | 33 ms |

Reads are about 15% slower and everything else is the same or faster. The read budgets
(150 ms p95 per command, 30 ms per MCP call) have room for that.

## Decision

1. The SQLite adapter (`packages/store-sqlite`) opens databases with `DatabaseSync` from
   `node:sqlite`. `better-sqlite3` and `@types/better-sqlite3` are removed. The class is used
   by its `DatabaseSync` name: Node 26.11 added the alias `Database`, which older versions lack.
2. Drizzle stays. Drizzle 0.45.4 has no `node:sqlite` driver, so the adapter runs Drizzle's
   `sqlite-proxy` driver over a small executor that runs Drizzle's SQL on the `DatabaseSync`
   connection. Migrations, embedded by `drizzle-kit generate`, are unchanged. The adapter
   already opens, commits and rolls back transactions itself (ADR 0001), so no Drizzle
   transaction API is needed.
3. The adapter exposes the pragmas the CLI reads (`integrity_check`, `data_version`, `VACUUM`)
   as methods, so `sati doctor` and the UI server stop reaching into the driver.
4. The minimum Node version becomes 24.15. That is the first release where `node:sqlite` is a
   release candidate and prints no warning. `engines` in both `package.json` files, `.nvmrc`
   and `.github/workflows/ci.yml` (the test matrix becomes Node 24 and 26 instead of 22 and 24,
   and the one job pinned to Node 22 moves to 24) change with it.
5. The database file format does not change. SQLite reads the same files from either driver,
   so an existing `.git/sati/sati.db` opens as is, and no data migration is needed.

## Consequences

- Install drops from 56 MB to about 29 MB, and no package compiles or downloads a binary.
  Installs stop failing on platforms without a prebuilt addon, and a new Node major no longer
  waits for one.
- 29 MB is still over the 15 MB budget. Reaching it is a separate change, not a stack change.
  The CLI already bundles `zod` and `drizzle-orm` (`packages/cli/tsdown.config.ts`); `zod` is
  installed anyway because the MCP SDK depends on it. Bundling the MCP SDK, `hono`,
  `@hono/node-server` and `@clack/prompts` as well would leave nearly nothing to install,
  since only the code sati uses goes into the bundle. That needs its own check against the
  80 ms `--version` budget, because the MCP SDK is loaded lazily today.
- Users on Node 22 can no longer install sati. Node 22 is in maintenance until April 2027, and
  Node 24 and 26 are both LTS. `sati` must say this clearly: `engines` makes npm warn, and the
  CLI checks `process.versions.node` at start and exits with a hint to upgrade.
- `node:sqlite` is a release candidate, not stable. Its API may still change in a Node minor.
  The adapter is the only module that imports it, so a change is fixed in one file. The CI
  matrix runs on the newest Node 24 and 26 releases to catch one early.
- The PLAN tech stack rows for "Local database" and "Considered and rejected", the install
  risk row and the Phase 0 Node matrix are updated when this is accepted.

These must pass before the switch lands:

- The store tests, including the query-plan tests (`EXPLAIN QUERY PLAN` shows no temp B-tree)
  and the migration backup test.
- The concurrency test: 20 processes claiming one task, exactly one wins and none sees
  `SQLITE_BUSY`. This checks that the `timeout` option behaves like `busy_timeout`.
- The four-agent end-to-end test, and `pnpm bench` within 20% of the current numbers.
- A clean install of the packed CLI on Linux, macOS and Windows with no build tools present.

## Alternatives considered

- **Keep better-sqlite3.** It is stable and slightly faster on reads, but it is half the
  install and the main install risk. It stays the fallback if the concurrency test or the
  benchmarks fail on `node:sqlite`.
- **Support both drivers and pick one at run time.** Node 22 users keep working, but every
  store test runs twice and the 27 MB stays in the install for everyone, since npm cannot
  install it only where needed. An `optionalDependencies` entry would still download it.
- **Keep Node 22 and hide the warning.** Removing the `warning` listener before importing
  `node:sqlite` hides the message, but it also hides other warnings, and the API on Node 22 is
  still "active development". Not worth it a few months before Node 22 leaves support.
- **A standalone binary built with Bun** (`docs/ideas.md`). It needs no Node at all, but needs a
  second store adapter on `bun:sqlite` and a second distribution channel. It stays deferred to
  Phase 6 distribution; this decision does not block it.
- **sql.js or another WebAssembly SQLite.** No native build, but it runs in memory and writes
  the whole file back, which breaks WAL and sharing one database across worktrees.
