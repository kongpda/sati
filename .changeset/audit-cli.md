---
"@kongpda/sati": patch
---

More fixes from the audit, in the CLI.

- Git hooks let a commit through, with a hint, when the recorded `node` is gone. Before, only the script was checked and every commit was blocked.
- `sati doctor` reads the hook command correctly when its path has an apostrophe, and no longer offers to remove the worktree it runs in.
- `sati init --upgrade` refuses `--mode`, `--kind`, `--name` and `--slug` instead of ignoring them.
- `sati review` gives the same verdict as `sati guard`: it uses the project's `maxRemovalRatio` and skips general projects.
- Worktree paths are compared through their real path, so `/tmp` and `/private/tmp` match on macOS.
- The merge driver and the `.sati/` export retry a rename that Windows refuses for a moment.
