---
"@kongpda/sati": patch
---

A person can take over or release a task an agent is working on: "Take over" and "Release" in the board's task panel, "Release" per task on the Agents page, and `sati task release [--force]` and `sati task take-over` on the command line. Only people can end another actor's live claim; it asks first and is logged.
