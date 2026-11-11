---
"@kongpda/sati": minor
---

`sati task show`, `sati task complete`, `sati task release` and `sati handoff` no longer need a task id when you hold exactly one task. With none or several they ask which, and list them. Validation errors are shorter: `Invalid input: priority: expected one of low, medium, high, urgent`.
