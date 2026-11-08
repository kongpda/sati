---
"@kongpda/sati": minor
---

sati now uses Node's built-in SQLite (`node:sqlite`) instead of the native `better-sqlite3` addon, so installing it no longer downloads or compiles a native binary. It needs Node.js 24.15 or newer; on an older Node, `sati` exits with a message saying so. Existing databases open as they are.
