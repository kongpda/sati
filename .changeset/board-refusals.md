---
"@kongpda/sati": patch
---

The board no longer offers an action the server refuses.

- Dragging a card dims the columns it cannot go to and says why; a refused drop sends nothing. The bulk "Move to" menu and the status list in the task panel show only where the task can go.
- Sending work back from review asks what still needs doing, from the panel, a drag or the bulk menu.
- A task someone else is working on is marked on its card and locked in the panel until it is taken over or released. "Take over" shows only where the task can be claimed again.
- A board started from an agent's terminal says so, and does not offer what only a person may do: approving work, taking a task from someone, editing people.
- A bulk move lists each reason with the number of tasks it stopped.
- The task title is required in the panel; a note cannot take the tag kept for comments.
- Refusals use the board's words for statuses and leave out record ids.
- `sati projects` says "database not readable" where it printed `ready -1`.
