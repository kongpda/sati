---
"@kongpda/sati": patch
---

`sati task list` and `sati search` say when a list was cut at its limit: "Showing the first 50. Use --offset 50 for more." Text output ends with the line; with `--json` the array is unchanged and the line goes to stderr.
