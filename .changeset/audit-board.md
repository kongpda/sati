---
"@kongpda/sati": patch
---

Fix findings from the audit in the board.

- Moving one card twice in a row no longer shows a conflict: the second move waits for the first.
- "N of M tasks did not move" stays until it is closed.
- Esc closes a form dialog when focus is outside its form.
- `x` and Enter act only on the board, so a card that is not shown cannot be selected.
- Search in a general project no longer offers features, whose page is hidden there.
- The project kind choice in Settings cannot stay locked after a failed reload.
