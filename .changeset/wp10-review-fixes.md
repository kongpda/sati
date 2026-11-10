---
"@kongpda/sati": patch
---

Fixes from the review of the core services and the guard:

- The guard blocks emptying a file of a protected feature, even when a big edit elsewhere keeps the feature's removal ratio low.
- The Claude Code hook blocks `rm -rf .` and the repo root, sees `rm` behind `time`, `nice`, `nohup`, `env -i`, `sudo -u`, `bash -lc`, `&` and `if`/`for` bodies, and blocks more ways to skip the git hooks: `--no-verif`, `git config core.hooksPath`, `--config-env`, `GIT_CONFIG_KEY_n` and removing a hook file.
- `sati doctor` in stealth mode no longer says records are shared through `.sati/`.
- `sati changes --digest` leaves internal tasks out of "Needs attention", and `--since` refuses a date such as 2026-02-31.
- The brief puts a feature's acceptance criteria in a `data` fence.
- MCP `task_claim` with no id returns the task like the CLI, plus its feature's `acceptance`.
- `sati note create --links` and `note update --links` store a short handle as the full id, as MCP does.
