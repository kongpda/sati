---
"@kongpda/sati": patch
---

Large projects are much faster. After a write, the CLI, MCP server and UI export only the records that write touched to `.sati/`, instead of every record (a claim on a 50,000-record project went from 10 s to 0.4 s). The full export at commit time scans only the files it is about to change for secrets, and listing every record pages by cursor instead of by offset. `sati guard` reads decisions only when a change touches a shipped feature.
