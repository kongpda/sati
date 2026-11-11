---
"@kongpda/sati": patch
---

Cards can tell staleness from the caller: `sati card get <path> --seen <version>` and `context_get` with `seen` compare the file's version now with the one the card was saved with. A card path may name a part of a file (`budget.xlsx#Sheet2`, `deck.pptx#slide-12`, `contract.pdf#p4`) and goes stale when the file changes. A card saved while its file had uncommitted changes stays fresh when the same content is committed.
