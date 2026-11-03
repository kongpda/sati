# Ideas

Ideas not in `PLAN.md`. Do not build these without adding them to the plan first.

- **Terminal board** (`sati board`): a kanban view in the terminal for people who never open the web UI. Raised 2026-11-03 with the daily-workspace items; deferred because Phase 4 builds the real board.
- **Write ticks back to Markdown**: when a task imported by `sati plan import` completes, tick its `- [ ]` line in the source file. Deferred: editing user files from a background write is surprising and conflicts with hand edits.
- **Import from GitHub Issues or Linear**: one-way import into tasks for teams moving to sati. Deferred: the plan's non-goals say sati does not replace issue trackers.
- **Unattended agent runner**: a `sati work` loop that starts an agent per ready task. Deferred: `autoContinue` plus the review gate covers the safe version; spawning agents is out of scope.
- **Standalone binary built with Bun**: `bun build --compile` produces one file that needs neither Node nor Bun, for a Homebrew or `curl | sh` install next to the npm package. Needs a second store adapter on `bun:sqlite` (the native `better-sqlite3` does not compile into the binary) behind the existing `StorageAdapter` port, and the CLI tests run against the binary. Measured 2026-11-03: `sati task list` takes 49 ms on Bun 1.4.4 against 77 ms on Node 26. Deferred: PLAN keeps Node as the runtime (users install with npm) and Node is within the cold-start budget; revisit with Phase 6 distribution.
