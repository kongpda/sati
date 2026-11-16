---
"@kongpda/sati": patch
---

The installed `sati` command no longer needs the private `@sati/core` package beside it. A build that left the product name as a runtime import died with "Cannot find module" whenever that package's build output was missing.
