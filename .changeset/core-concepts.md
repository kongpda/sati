---
"@kongpda/sati": minor
---

Decisions can no longer be deleted. A decision that names a feature lets a change to that feature through the guard, and deleting it silently took that permission back. **Breaking:** `sati decision delete` and `sati decision restore` are gone, and so are the board API routes for them. To change a decision, record a new one with `--supersedes`. `sati decision show` and `recall` now say which decision replaced an old one. Decisions that were deleted before this release stay deleted.

Milestones can be cancelled: `sati milestone update <id> --status cancelled`. A cancelled milestone can be reopened as planned, but it cannot go straight to done. A plan import adds no tasks to a cancelled milestone. If an older sati imports a snapshot with a status it does not know, it now says a newer sati wrote the files.

The agent workflow now gives three ways to say a task waits: `blocked` with a reason, `needsInput` on a live claim, or a comment.

A write that changes many records, such as a plan import, now updates the agent's sync stamp once instead of once per record.
