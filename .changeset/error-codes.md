---
"@kongpda/sati": minor
---

Refusals that depend on who acts or on a record's state now all use exit code 8 (`INVALID_TRANSITION`). These used to exit 4 or 5: an agent's forced release or take-over, an agent changing a profile, every `undo` refusal, releasing a task that is not claimed, asking for input on a task you do not hold, and editing another author's comment. Exit 5 now means only that the input has the wrong shape, and exit 4 means a lost version race or a claim or lock held by someone else.
