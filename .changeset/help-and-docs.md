---
"@kongpda/sati": patch
---

`sati decision delete` accepts a short handle; it said "not found" for a live decision unless given the full id. Command help now states limits, defaults and exit codes: `sync export` exits 5 on a refused secret, `guard` exits 10 when blocked, `doctor` exits 5 on a failed check, the maximum `--limit` of `search` and `activity`, the allowed status values, and the `--project <slug>` flag (under `sati projects`).
