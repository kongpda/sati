---
"@kongpda/sati": patch
---

Fixes from a whole-project review. A merge of two `.sati/sati.config.json` edits no longer breaks the project: only record folders go through the merge driver (run `sati init --upgrade --yes` to refresh `.gitattributes`). An export never overwrites a `.sati/` file that is newer than the database. `undo` removes a field the change first set. Moving a claimed task back to `todo` frees its locks. MCP prompts in a general project name no feature tool. On the board, Delete keeps the task when you keep unsaved edits, and approving from the panel records the commit you saw.
