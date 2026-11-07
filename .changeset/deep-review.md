---
"@kongpda/sati": patch
---

Close more gaps found in a deep review. The Bash guard hook now catches `git mv`, `/bin/rm`, subshells, `cd dir && rm`, `mv -t`, `unlink`, `sh -c` and moves out of the repo, and blocks `git commit --no-verify`, `git push --no-verify` and `-c core.hooksPath`. `undo` refuses claims, releases, completions, locks and tasks another actor holds. Comma-separated flags keep brace globs such as `src/{a,b}/**` whole. The merge driver keeps a teammate's cleared `needsReview`. The secret scanner no longer blocks numeric settings and finds passwords in URLs and npm and GitLab tokens. The board refreshes in every tab after a write, lets a person approve work in review, and ignores Ctrl, Cmd and Alt shortcuts.
