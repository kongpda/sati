---
"@kongpda/sati": patch
---

CLI fixes. `--label` and `--labels` both work on `task list`, `create` and `update`. `--feature none`, `--parent none` and `--depends none` clear those links. `--body -` with nothing on stdin is a usage error instead of an empty body. Hooks no longer wait for input when run by hand in a terminal. `sati review` prints each guard finding, lists only decisions made since the range began or linked to a feature it touches, and leaves `.sati/` out of the file list. Two `sati serve` started together no longer crash: the second exits 4. New `sati projects --prune` forgets projects whose folder or database is gone. `SATI_REGISTRY` points the project registry at another file. The board's API description reports the real version.
