---
"@kongpda/sati": patch
---

Faster lock checks in projects with many released locks, and fewer activity rows from lease renewals. `sati plan import` holds the write lock for less time. `sati serve` reports an over-limit message instead of dropping the connection, and its socket is readable only by its owner. The board retries a failed load once and no longer refetches on every window focus.
