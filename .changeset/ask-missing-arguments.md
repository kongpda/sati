---
"@kongpda/sati": minor
---

At a terminal, `sati task create`, `task complete`, `comment add`, `note create` and `decision record` ask for what you left out, then print the command that does the same. `task complete` offers the files git says you changed. A note's text and a decision are written in `$VISUAL` or `$EDITOR` when one is set; saving an empty file cancels. Scripts, pipes, agents and `--json` are never asked and get the same usage errors as before.
