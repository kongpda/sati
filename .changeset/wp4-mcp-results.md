---
"@kongpda/sati": patch
---

MCP: new `task_get` tool reads one task in full. Updates (`task_update`, `task_complete`, `note_upsert` and `feature_upsert` with an id, `context_put`) now return only the id, version, status, claim and the fields the call set, instead of the whole record. `task_list` rows use short handles. `context_get` with no path lists up to 50 card paths with a total. `task_create` takes `ifSimilar: "return"` to create nothing when a strong match exists, and subtasks can set `effort`. Every tool has MCP annotations. Absolute paths under a symlinked repo root now count as inside the repo. The rules block says `task_complete` needs the claim token, names `recall`, and says the brief marks `light` tasks: run `sati init --upgrade` in each project.
