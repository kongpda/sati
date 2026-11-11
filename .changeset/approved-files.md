---
"@kongpda/sati": minor
---

A person can sign off a file with `sati card approve <file>`. sati stores the SHA-256 of the file's bytes on its card, never the contents. The guard (`sati guard`, the pre-commit hook, the Claude Code edit hook, MCP `feature_check`) then blocks a change, a move or a removal of that file until the new version is approved, also in a general project where the guard was off. An agent sees `approved` on the card from `context_get`. `sati card get` shows `approved`, `CHANGED since it was approved` or `approved file is MISSING`. `--clear` takes the approval away.
