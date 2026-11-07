---
"@kongpda/sati": patch
---

A claim's fencing token now works only for the agent or person who holds the claim, so a token copied from `task show` cannot be used by anyone else. Timestamps in imported `.sati/` files are stored with millisecond precision, so a lease written without milliseconds no longer looks live after it ran out.
