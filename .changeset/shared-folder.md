---
"@kongpda/sati": minor
---

A project outside git can be shared through a synced folder (Dropbox, OneDrive, iCloud Drive, a file server). `sati init --share`, or `sati sync share` for an existing standalone project, keeps the records as files in `.sati/`; the database stays in `~/.sati/` on each machine. Another person runs `sati init` in the synced folder to join. Every command, the board and the MCP server load the files that changed, and a "conflicted copy" the sync app made of a record is merged into it field by field and deleted. Changes arrive at the speed of the sync app; live claims and file locks across people still need the hosted server. See ADR 0009.
