---
"@kongpda/sati": minor
---

MCP: `task_list` and `search` now return `{ items, truncated }` instead of a bare array, so an agent knows when a list was cut (breaking for clients that read the result as an array). New tools: `task_release` hands a task back and frees its locks, and `milestone_upsert` is the new name of `roadmap_upsert`, which still answers. Tool descriptions are shorter (5,058 characters in all, down from 6,998), and the how-to detail moved to `sati://workflow`. The rules block gains "Stopping before done: `handoff_write`, then `task_release`"; run `sati init --upgrade` to refresh it.
