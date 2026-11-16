---
"@kongpda/sati": patch
---

`sati settings` checks every flag before it renames the project, so a bad flag changes nothing. A version flag after a command, as in `sati task create X --version`, is now refused instead of being ignored while the command runs.
