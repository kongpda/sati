---
"@kongpda/sati": patch
---

`.sati/` record files are about two-thirds smaller: empty fields are left out, and a clock stamp shared by most fields is written once. Files in the old full form still import and merge. The first export after upgrading rewrites every record file once.
