---
"@kongpda/sati": minor
---

Plan templates: `sati template apply event|campaign|release --date 2027-03-20` (or MCP `roadmap_upsert` with `template`, or New plan on the board's Roadmap) creates a milestone with its tasks in stages, each stage waiting for the one before and due dates counted back from the day. Add your own as `.sati/templates/<name>.md`. `sati plan import` now puts each task in its heading's milestone.
