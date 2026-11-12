---
"@kongpda/sati": patch
---

Core correctness fixes. A claim over an expired claim now frees the old holder's task locks, so the new holder can lock the same paths. The brief's sweep now also releases expired locks (up to 200 at a time), so the lock table does not fill. A short handle such as `tsk_8f3k2a` now looks only in the current project, so it no longer misses its record when more than 100 records in other projects share the ending; a running `sati serve` must be restarted after the upgrade (daemon protocol 3). A handoff's `files` entries must be repo paths; `/etc/passwd` and `../other/x.ts` are refused. A snapshot file that cannot be opened is reported as "cannot be read" (or "removed during the scan") instead of a raw error or "not valid JSON". `sati plan import` now says why it skipped a line: a repeated line names the line it repeats, and a heading whose milestone is deleted says its tasks are created without a milestone.
