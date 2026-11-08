---
"@kongpda/sati": patch
---

Claiming a task, writing a handoff and `sati brief` no longer read every note in the project to find handoffs; they look them up by index. On a 50,000-record project a claim took about a second and held the write lock the whole time, so agents claiming at once timed out with "database is locked". It now takes a few milliseconds.
