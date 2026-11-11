---
"@kongpda/sati": minor
---

`sati upgrade` updates a project's git hooks, merge driver and agent files in one short command; it replaces typing `sati init --upgrade --yes`, which still works. `sati completion bash|zsh|fish` prints a tab-completion script. Output taller than the terminal opens in your pager (`SATI_PAGER`, `PAGER`, then `less`); `PAGER=cat` turns that off. `sati review` wraps long lines, and a tab in a title no longer shifts a table column. A group typed alone (`sati task`) prints its help, `sati help <command>` works, and a missing argument shows what to type. `sati task claim --pick` lets you choose from the ready tasks. `sati completion` with no shell follows `$SHELL`.
