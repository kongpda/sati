---
"@kongpda/sati": minor
---

A card can describe a web link (a SharePoint or Drive file, a page) or a file outside the project folder: pass the link or the full path as the card path. Such a card is matched whole, has no automatic stale check (pass `--seen`), and a link with a user name, password or access token is refused. A card for a full path stays on this machine unless made with `--no-private`.
