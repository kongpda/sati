---
"@kongpda/sati": minor
---

`sati settings --name <text>` renames the project; only a person may. `sati settings --json` now includes `name`. `sati projects forget <slug|path>` removes a project from this machine's list without touching its folder or database; it asks first at a terminal, and needs `--yes` elsewhere. `sati doctor` checks other branches for a missing file with one git call instead of one per branch.
