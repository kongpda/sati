---
"@kongpda/sati": patch
---

Export refuses a record file in `.sati/` that is a symlink, folder or device, with a message naming the file. Before, such a file could make pre-commit hang or crash.
