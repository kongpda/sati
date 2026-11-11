---
"@kongpda/sati": minor
---

`sati --version` shows the commit the build was made from: `0.1.0+48a630b`, with `.dirty` when the build had changes that were not committed. `-v` and `-V` print the same line, and the MCP server reports it too. When sati runs from a source checkout, `sati doctor` says when the source has newer code than the build and names the command that rebuilds it.
