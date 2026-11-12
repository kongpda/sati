---
"@kongpda/sati": patch
---

`--label` and `--feature` can be given more than once (`--label a --label b` adds both). Giving an option together with its alias (`--label a --labels b`) is now refused instead of keeping one value.
