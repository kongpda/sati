# 0001. Async storage port over a sync SQLite driver

- Status: accepted
- Date: 2026-11-03

## Context

`better-sqlite3` is synchronous. Phase 6 adds PostgreSQL and a remote HTTP adapter, which are
asynchronous. Core services must run unchanged on every adapter, and every write must run in one
transaction together with its activity row.

## Decision

The `StorageAdapter` port is async: `read(fn)` and `write(fn)` take an async callback and return a
promise. The SQLite adapter runs each `write` inside `BEGIN IMMEDIATE … COMMIT`, and serialises
writes in the same process with a promise-chain mutex, so two awaited callbacks never interleave
inside one SQLite connection. Cross-process safety comes from SQLite's write lock and
`busy_timeout`.

## Consequences

- Core services are written once and run on SQLite, Postgres and remote adapters.
- Each SQLite call pays a small promise overhead. The read p95 budget (150 ms) leaves room for it.
- A write callback must not await slow external work (git, network): it holds the write lock.

## Alternatives considered

- Sync port: fastest for SQLite, but Postgres and HTTP adapters could not implement it.
- Two ports (sync and async): doubles the service layer and its tests.
