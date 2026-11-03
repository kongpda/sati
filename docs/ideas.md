# Ideas

Ideas not in `PLAN.md`. Do not build these without adding them to the plan first.

- **Terminal board** (`brain board`): a kanban view in the terminal for people who never open the web UI. Raised 2026-11-03 with the daily-workspace items; deferred because Phase 4 builds the real board.
- **Write ticks back to Markdown**: when a task imported by `brain plan import` completes, tick its `- [ ]` line in the source file. Deferred: editing user files from a background write is surprising and conflicts with hand edits.
- **Import from GitHub Issues or Linear**: one-way import into tasks for teams moving to brain. Deferred: the plan's non-goals say brain does not replace issue trackers.
- **Unattended agent runner**: a `brain work` loop that starts an agent per ready task. Deferred: `autoContinue` plus the review gate covers the safe version; spawning agents is out of scope.
