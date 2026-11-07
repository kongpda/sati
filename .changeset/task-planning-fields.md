---
"@kongpda/sati": patch
---

Tasks can have a due date, people or agents assigned to them, and a checklist. Set them in the New task form or the task panel, with `sati task create|update --due 2026-12-04 --assign me`, `sati task checklist <id> --add|--done|--undone|--remove`, or MCP `task_create` / `task_update`. Cards show the due day (in red once it has passed) and steps done. `task_list` and `sati task list` filter by `--due-by` and `--assignee`.
