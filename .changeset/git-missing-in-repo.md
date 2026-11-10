---
"@kongpda/sati": patch
---

Inside a git repository where `git` cannot run, sati now stops with an error that names git. Before, `sati init` quietly set up a standalone project with no git hooks, and other commands reported that there was no git repository.
