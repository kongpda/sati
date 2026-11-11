---
"@kongpda/sati": patch
---

An MCP client that sets no agent variable (Claude Desktop, Cursor) is now recorded as an agent named after the client, not as the person, so it cannot pass the review gate. Lock, guard and feature paths match without regard to letter case or Unicode form. `sati card put|get` and `sati lock acquire` take a path relative to the current folder or an absolute path inside the project. `sati init` outside a git repository defaults to kind `general`, shows the kind in `--dry-run`, and refuses the home folder and the top of the disk.
