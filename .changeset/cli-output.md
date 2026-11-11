---
"@kongpda/sati": minor
---

Output is laid out for the reader. In a terminal, lists are aligned and cut to the window, records show wrapped text and local times, `doctor` marks each check and counts them, `activity` shows who changed what, and finished actions get a check mark. In a pipe the lines stay compact and uncoloured, as before. Colour follows `NO_COLOR`, `FORCE_COLOR` and `TERM=dumb`, and every command takes `--no-color`. `sati --help` lists the commands in groups and no longer prints colour codes into a pipe. A wrong command word suggests the right one (`sati task get` says `sati task show`). Titles and notes are printed without terminal control characters, so stored text cannot rewrite the screen. The brief keeps its ready tasks when a long section above them uses up the budget.
