---
"@kongpda/sati": patch
---

`sati projects --json` gives an `error` field on a project whose database did not open, so an agent can see the cause. `ready` stays `-1` for such a project.
