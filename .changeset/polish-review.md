---
"@kongpda/sati": patch
---

Fix bugs found in a full review pass. The CLI rejects unknown flags with a suggestion and accepts `--project=slug`. `guard` measures removals against the range base and handles symlinked folders. `review` validates ranges and uses `origin/HEAD`. `doctor` exits non-zero when a check fails, and `scan --apply` can be run again safely. Plan import runs in one transaction. Undo refuses fields the log shortened. The daemon frees the write lock when a client disconnects. The board UI adds a Cancelled column, a drag handle, loading and error states, and fixes several layout bugs.
