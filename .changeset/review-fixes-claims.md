---
"@kongpda/sati": patch
---

A claim made on another machine or clone is no longer released as stale because a process with the same id is missing here; a restarted MCP server keeps its agent's claims. Changes are no longer lost when an export fails or the MCP server stops inside the export delay. A review is no longer flagged as "branch changed" when the only new commit is sati's own `.sati/` export. Notes and tasks written before the 100 KB byte limit import and edit again. `sati doctor` works on older git.
