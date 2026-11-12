---
"@kongpda/sati": minor
---

`sati` typed alone at a terminal shows what needs you, what is in progress and what is ready, then a menu of the common commands; each entry runs the command you could have typed. `sati task list --board` prints the board's columns as text: side by side in a wide terminal, stacked in a narrow one, one line per task in a pipe, and grouped by column with `--json`. `sati activity --follow` prints the last rows and then each new row as it is written, one JSON object per line with `--json`, until Ctrl-C. Scripts, pipes and agents still get the help text and exit code 2 from a bare `sati`.
