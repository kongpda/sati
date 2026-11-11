---
"@kongpda/sati": patch
---

Fixes from a full-project audit.

- A note or task with a long run of spaces on one line no longer freezes the secret check (it took over 20 seconds on a 100 KB line).
- A lock or guard path written as `src/./a.ts` now covers `src/a.ts`.
- Through `sati serve`, `task list --ready` no longer fails with "No task with id null", and a malformed message no longer stops the server.
- `sati projects` no longer creates an empty database for a project whose database is gone; it shows `ready -1`.
- `sati changes` lists every blocked and overdue task, not only the first 500.
