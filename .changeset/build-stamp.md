---
"@kongpda/sati": minor
---

`sati --version` shows the commit the build was made from and that commit's date: `sati 0.1.0 (48a630b 2026-11-11)`, with `48a630b-dirty` when the build had changes that were not committed. `-v` and `-V` print the same line. The MCP server reports `0.1.0+48a630b`. `sati doctor` starts with the environment a bug report needs (version, node, system, install and store paths; `environment` in `--json`), and when sati runs from a source checkout it says when the source has newer code than the build.
