# Glossary

The board uses everyday words. The CLI, MCP tools and `.sati/` files keep the exact terms, so
scripts and agents do not break. This table maps one to the other; the board's words live in
`packages/ui/src/words.ts`.

| On the board | CLI, MCP and files | Meaning |
| --- | --- | --- |
| To do | `todo` | Ready to be picked up. |
| Working on it | `in_progress` | Someone has started; usually they also hold a claim. |
| Waiting for approval | `review` | Finished and waiting for a person to approve it or send it back. |
| Backlog, Done, Blocked, Cancelled | `backlog`, `done`, `blocked`, `cancelled` | Same words. |
| "Kong is working on this until 2:32 PM" | claim, `leaseUntil` | Who has the task, and until when (your local time). |
| "time on this ran out" | expired lease | The claim's time passed; anyone may take the task now. |
| Take over | `sati task take-over` | A person takes a task from whoever has it. Logged. |
| Release | `sati task release` | The holder (or a person, with `--force`) gives the task back. |
| Free up tasks whose time ran out | `POST /api/claims/release-expired` (board only) | Hands every expired claim back; agents and `task claim` also take expired tasks on their own. |
| Approve | `sati task update <id> --status done` | A person accepts work waiting for approval. |
| Send back | `--status todo --reason "…"` | Returns the task with a note the next person or agent sees. |
| Reserved for editing | exclusive lock | Others wait until it is released. |
| Sharing for editing | shared lock | Several can edit; it is still shown. |
| File summary | context entry | An agent's note about a file or folder. |
| Edited in two places · Looks right | `needsReview`, `--reviewed` | A sync merged two copies; check the result and confirm. |
| Person, AI agent | actor `kind: human`, `agent` | Who did something. |
| Software project, General project | `kind: code`, `kind: general` (`sati settings --kind`) | A general project (an event, a campaign) has no features, file reservations or guard. |
| Due date, Assigned to, Checklist | `dueDate`, `assigneeIds`, `checklist` | Planning fields on a task. |

Times on the board are in your own time zone and clock style, with the full date in the
tooltip. Due dates are calendar days ("by Friday") and never shift between time zones.
