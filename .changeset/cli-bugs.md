---
"@kongpda/sati": patch
---

CLI fixes. `sati activity --since` takes `7d`, `2w` and a day, as `sati changes` does. `sati activity` text output now starts each row with the activity's short handle (such as `act_8f3k2a`), and `sati undo` takes that handle; scripts that read the first column of `activity` text must skip it. Validation errors name the flag (`--max-tokens`, `--date`) instead of an internal field, and say each reason once. In a project set up with `--cli-only`, the end-of-turn reminder names `sati task complete` and `sati task update` instead of MCP tools; run `sati upgrade` to rewrite the hook. `sati milestone update --date none` clears the target date. A running `sati serve` must be restarted after the upgrade (daemon protocol 4).
