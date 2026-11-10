---
"@kongpda/sati": patch
---

Board fixes from review WP6. Forms no longer lose typed text on a stray click: a dirty form ignores the backdrop and asks before Esc closes it. Saving the task panel says "Saved", keeps focus on Save and no longer flashes the "changed while you were editing" notice; the paths form does the same. A task deleted elsewhere says so instead of asking to discard edits. A comment typed on Notes or Decisions asks before you leave the page. A second change keeps its highlight for the full time.

Clearer feedback and wording: copy failures say "Could not copy. Select the text and copy it by hand."; the New task form says "Status", like the rest of the board; the effort choice explains that light tasks can go to a faster, cheaper agent; freeing tasks, creating a note and sending work back now show a toast; removing a checklist step has Undo. The task body shows rendered until you choose "Edit details". Links on the Changes page, the search palette and Memory open the item itself. The palette clears old results as you type and says when it shows only the first 20. Relative times such as "just now" update every minute.

Accessibility: the Settings choices stay focusable while saving, "Approve latest" has a label that contains its visible text, and small badge and avatar text is 12 px. Markdown now renders a heading straight after a paragraph, `*` bullets and nested lists.
