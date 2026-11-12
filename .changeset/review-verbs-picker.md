---
"@kongpda/sati": minor
---

`sati task approve` and `sati task send-back --reason "…"` are the terminal's two review buttons. At a terminal you may leave the task id out of them, and out of `task update`, `task show` and `task claim`: sati shows a list to choose from, then prints the command that does the same. Scripts, pipes, agents and `--json` are never asked. `--no-input` or `SATI_NO_INPUT=1` turns the questions off for a person too.
