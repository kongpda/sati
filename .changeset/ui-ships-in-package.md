---
"@kongpda/sati": patch
---

`sati ui` now works from the installed npm package: the built board ships inside the CLI's `dist/ui`. It no longer looks for a page under the working directory, so a repo cannot plant its own page and run it with the session cookie.
