---
"@kongpda/sati": patch
---

Fix findings from the audit in the store and the MCP server.

- The network-drive warning now works on macOS (the filesystem type was read wrongly, so it never fired).
- `sati serve` names the limit when the socket path is too long, instead of a bare `EINVAL`.
- When git fails inside a repository, the error keeps git's own message, and says to leave `.git` when run inside it. A standalone project below a broken `.git` opens again.
- MCP tool errors come back in the same data fence as results.
- Faster writes: the search index is rewritten only when a record's text changes. New indexes find a milestone's tasks and features.
