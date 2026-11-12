---
"@kongpda/sati": patch
---

Small CLI fixes. `sati task checklist` works on the task you hold when you give no id, as `show`, `complete` and `release` do. `sati feature list --md` prints the shipped-features Markdown; `--format md` still works but is no longer listed. `--reviewed` on `task update`, `feature update` and `note update` still works but is no longer listed: `sati doctor --reviewed <id>` is the documented way to clear the review flag. `sati --help` shows the same version line as `sati --version`. `task list --help` lists the statuses in the order errors use, and says that `--board` off a terminal prints one task per line and ignores `--limit`.
