---
"@kongpda/sati": patch
---

Core fixes from the review:

- `sati undo` refuses a revert that the state machine forbids or that would link a task to a deleted record, with exit 4 and a hint to edit by hand.
- A lock tagged with another agent's task is refused only while that task is in progress, not while it waits in review or is blocked.
- `task list --ready` with a filter (such as `--effort light`) finds matches past the first 500 ready tasks.
- `sati plan import` skips headings and checkboxes inside code fences.
