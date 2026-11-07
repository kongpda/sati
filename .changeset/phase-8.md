---
"@kongpda/sati": minor
---

Knowledge brain: agents save what they learn about a file as a card (`sati card put <path> --summary … --facts …`, MCP `context_put`), and anyone asks before reading with `sati recall "<question>"`, MCP `recall` or the board's new Memory page. Answers are capped at 1,000 tokens with their sources. Notes and cards can be kept on this computer only (`--private`), never written to `.sati/`; `sati doctor` lists them. Pinned notes show on the board and in every brief. Secrets in notes, comments and cards are refused when saved.
