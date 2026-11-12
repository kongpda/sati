---
"@kongpda/sati": patch
---

Fixes from a review of the whole project. A write on a record the export refuses (a secret in a field) printed "Maximum call stack size exceeded"; it now prints the warning and keeps the write. Completing a task that is already done is refused instead of replacing its summary. A note cannot be given the `handoff` tag by hand. A snapshot file whose id is not text is refused with a clear message. `sati comment add` with one word says the record comes first. `sati inbox` is listed under Start in the help.
