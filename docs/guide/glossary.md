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
| Comments | a note tagged `comment`, linked to the record (`sati comment add`) | A reply on a task, note or decision. Agents see the newest one by someone else on their task in the brief. |
| Changes, Copy changelog | `sati changes --format changelog`, MCP `changes` | What changed in a time range. The changelog uses each task's release note (`--release-note`), falling back to its summary, and leaves out tasks labelled `internal`. |
| Since my last visit | `--since last-session` | From your previous session's last write; for an agent, its previous session with the same name. |
| Copy feature list | `sati feature list --format md` | Shipped features with their acceptance criteria, by plan. |
| New plan | `sati template apply <name>`, MCP `roadmap_upsert` with `template` | A milestone and its tasks from a template (event, campaign, release, or `.sati/templates/<name>.md`). Each stage waits for the one before; due dates count back from the day. |

Times on the board are in your own time zone and clock style, with the full date in the
tooltip. Due dates are calendar days ("by Friday") and never shift between time zones.

## Writing a template

A template is a Markdown file in `.sati/templates/<name>.md`, committed with the project. A file
named like a starter (`event`, `campaign`, `release`) replaces it. `sati template show event`
prints a starter to copy.

```markdown
# Team offsite
Goal: Two days away, everyone back rested.
Labels: offsite

## Travel (-2w)
- [ ] Book the bus
  - [ ] Ask three companies for quotes
- [ ] Collect dietary needs

## After (+3d)
- [ ] Share the photos
```

`(-2w)`, `(-10d)`, `(0d)` and `(+3d)` place a stage before or after the plan's day. An indented
`- [ ]` is a checklist step of the task above it. Other lines are ignored, so notes for the next
editor can stay in the file.

