---
"@kongpda/sati": patch
---

Fix findings from the audit in core and the CLI.

- `sati doctor` lists every record the merge driver flagged for review, not only tasks. `sati doctor --reviewed <id>` clears the flag after a person has read the record.
- `plan import --dry-run` and `template apply --dry-run` now refuse what the real run refuses: a secret, a title that is too long, a milestone name that exists.
- The shell guard no longer reads `git commit -m -n` as `--no-verify`, reports the right target for `mv dir/ dest/`, and sees the removal of a husky hook file.
- `sati review` and `sati scan` read every feature and every task in review, not the first 500.
- Two `sati init` runs at the same time no longer drop a project from `sati projects`.
- A personal workspace folder that is missing from the project list gives a clear message instead of `EEXIST`.
