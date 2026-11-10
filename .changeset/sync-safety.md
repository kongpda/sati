---
"@kongpda/sati": patch
---

Sync safety: a secret in a task, decision, feature or milestone is refused when it is written, as in notes. An export skips a record with a secret, writes the others and names the file and field (pre-commit still stops the commit). Pre-commit and `sati mcp` load newer `.sati/` files before they export. A symlinked `.sati/` folder is refused, and temp files left by a killed export are removed. The merge driver keeps a conflicted body under the size limit and merges checklist ticks item by item. A local edit and a teammate's file at the same version are merged field by field instead of one replacing the other. A cleared effort is left out of the file. A claim from a teammate's clone shows as "another machine".
