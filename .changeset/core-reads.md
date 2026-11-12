---
"@kongpda/sati": patch
---

Large projects read less: the brief, the guard, `recall`, `changes`, comments, handoffs, an import after `git pull` and `sati review` now ask the database for the records they need instead of reading whole tables. A sati serve from an older version still answers correctly; it only reads more.
