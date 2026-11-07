---
"@kongpda/sati": minor
---

Comment on tasks, notes and decisions from the board, `sati comment add|list` or MCP `note_upsert` (tag `comment`, one link). The brief shows the newest comment by someone else on each claimed task. MCP `task_list` now returns short rows unless `detail: "full"`, and a deleted dependency no longer blocks the tasks that depend on it.
