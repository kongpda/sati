# Team brain: the brain for AI agents and the people who use them

Nov 7, 2026 · plan for PLAN.md Phase 7 · @kongpda

## Why

Today sati is very good at one job: stopping parallel coding agents from colliding, and giving
each one a short brief instead of a crawl of the repo. The same records (tasks, decisions, notes,
milestones, activity) are exactly what an office, events or marketing team keeps scattered across
chat threads, spreadsheets and people's heads. Make those records easy for non-developers to
write and read, and sati becomes the one place the whole team, and every AI assistant it uses,
remembers from.

sati is the brain AI agents work from, and where their users plan, keep todo lists and take
notes. It also looks back: it reviews what was done and what changed, and writes changelogs and
feature lists from that record.

The work splits into what helps every user locally (7a–7c) and what needs the team server from
Phase 6 (7d). Do 7a first: every item in it also helps developers.

## Two ways to work, one memory

A person can plan and record work two ways, and both write the same records:

1. **Through their AI agent in the project.** "Plan the launch as a checklist", "add a todo to
   book the venue", "note that the client prefers blue", "what changed since Monday?", "write the
   changelog for 1.2". The agent calls sati's MCP tools (or the CLI) and answers from sati.
2. **In the sati web UI.** The board, lists, notes and the roadmap, for planning and working by
   hand, with live updates when an agent changes something.

A capability counts as done only when both ways have it. Today they are uneven:

| Capability | Agent (MCP / CLI) | Web UI |
| --- | --- | --- |
| Todos | Full | Title-only create through a hidden key; no complete |
| Plans (milestones) | Full | Read only |
| Notes | CLI only (no MCP tool) | Create; no edit, tags, pin or delete |
| Decisions | Full | Read only |
| What changed | Raw activity, git-only review | Raw activity |
| Changelog, feature list | None | None |

Phase 7a closes the parity gaps, and a parity test runs each capability through MCP and through
the UI and checks that the records match.

## Review what changed, write changelogs and feature lists (Phase 7b)

sati already records what happened: each finished task has a summary and its files, features have
statuses and acceptance criteria, decisions have reasons, and every write has an activity row. Phase
7b turns that record into answers people need:

- **"What changed?"** `sati changes --since 7d` (and the MCP `changes` tool) lists finished work,
  features that moved, decisions, new notes, and what is now blocked or overdue, grouped by
  milestone or feature. `--since last-session` gives an agent exactly what others did while it was
  away, and the brief gains that section, which PLAN promised but the brief never had.
- **Changelogs.** `task_complete` takes an optional one-line `releaseNote` written for users, next
  to the developer `summary`. `sati changelog --since v1.1` prints Markdown in Keep a Changelog
  style (Added / Changed / Fixed / Removed) or as release notes; tasks labelled `internal` are left
  out. It prints to stdout, so the agent or person chooses where it goes; sati writes no user files.
- **Feature lists.** `sati features --format md` prints what the product does today, from shipped
  features with their acceptance criteria, for a README, a sales sheet or a release page.
- **Review.** `sati review --since` works without git, and points out finished work still waiting
  for approval, decisions with no linked task, and shipped features with no tests.
- **In the UI,** a Changes page shows the same timeline with filters and "Copy changelog" and
  "Copy feature list" buttons that use the same generators, so both ways give the same text.

## Who it is for

| Person | Job to be done | Blocked today by |
| --- | --- | --- |
| Developer with agents | Agents pick work, don't collide, remember decisions | Works today; open bugs in Phase 5b |
| Team lead / owner | See who (person or agent) is doing what, approve work, find why we decided something | No assignees or due dates; approving from the UI was fixed in 5b |
| Events coordinator | Plan an event as a checklist with dates, owners and a venue decision | No due dates, assignees or checklists; needs a terminal and git; English only |
| Marketing | Run a campaign: brief, assets, approvals, a weekly status | No templates, comments or digest; only `window.prompt` to create a task |
| Office / admin | Keep how-tos and policies findable; ask "how do we…?" | Notes can't be edited, tagged or pinned in the UI; agents can't write notes |

## What exists and what is missing

Grounded in the 2026-11-07 review of the code:

- **Data.** A task has title, body, status, priority, feature, parent, dependsOn, labels, branch,
  worktree and claim. It has no due date, no assignee (the claim is a 30-minute agent lease, not
  ownership), no checklist and no comments. Only milestones have a `targetDate`.
- **People.** A human is `$USER@worktree`, taken from the OS. There is no display name, and no way
  to add a teammate.
- **UI.** Tasks are created only with the hidden `c` key and a title-only prompt. Milestones,
  decisions and features cannot be created in the UI; notes can be created but not edited. A
  claimed task cannot be moved by a person. Statuses show as `in_progress`; times as raw ISO.
- **Access.** Setup is Node + git + `sati init` + `sati ui` in a terminal, and the server binds to
  `127.0.0.1` with a new sign-in token each run. A colleague cannot open it from their laptop.
- **Agents.** MCP has 15 tools but none writes or reads a note, so agents can search the brain
  but not add to it.
- **Language.** Khmer is named in the CSS, but the font is not shipped and the CSP blocks web
  fonts, so Khmer text shows as boxes on machines without a Khmer system font.

## Recommendations

1. **One product, two project kinds.** Do not fork a "business edition". Add `kind: general` to a
   project: it hides Features, locks, the guard and the Agents page, and needs no git. Every rule
   still runs in the same core, so an agent can work in a marketing project the same way it works
   in code.
2. **Assignee is not a claim.** Keep claims as the agents' short lease. Add `assigneeIds[]` for
   ownership that lasts weeks and that a person sets. An agent assigned a task still claims it to
   work on it. Mixing the two would break the claim rules the guard relies on.
3. **Plain words in the UI only.** The UI says "working on it", "waiting for approval" and "until
   14:32" in local time. CLI and MCP keep `claim`, `review` and UTC, because agents and scripts rely
   on them and the MCP schemas are a public API.
4. **The brain is notes + decisions + search, served to any assistant.** Add `note_upsert`,
   `note_get` (Phase 7a) and a `recall` tool (Phase 8, `docs/knowledge-brain.md`) that returns ranked records with IDs. Do not bundle a model: the
   user's own assistant (Claude Code, Claude Desktop, ChatGPT through remote MCP) writes the
   answer. That keeps sati small, local-first and model-neutral.
5. **Templates beat features.** An event, a campaign and a release are each a milestone plus a
   task chain. Ship them as Markdown templates that reuse `plan import`, instead of building event-
   or campaign-specific screens.
6. **Non-developers need the team server.** No amount of local polish lets a colleague open a
   board on someone else's laptop. Phase 6 (hosted) is the real unlock for office users; sequence
   7d right after it, and keep 7a–7c useful on their own.
7. **Telegram before Slack** for notifications if the team is in Cambodia, where Telegram is the
   default work chat; email first for everyone.
8. **Keep the developer budgets.** New fields must not grow the brief past 1,500 tokens: due dates
   and assignees show only for tasks in the brief already, and comments never enter it.

## Data model changes (Phase 7a)

| Entity | Change | Notes |
| --- | --- | --- |
| Project | `kind: "code" \| "general"` (default `code`) | `general` uses the standalone store when there is no git |
| Actor | `displayName`, `initials`, `color` for humans | Editable in Settings; agents keep their tool names |
| Task | `dueDate` (ISO date, nullable), `assigneeIds[]`, `checklist[]` of `{ text, done }` | Validated like every field; arrays capped at 500 |
| Task completion | `releaseNote` (optional, one user-facing line, Phase 7b) | Changelogs use it, falling back to `summary`; label `internal` excludes a task |
| Comment (new) | `entity`, `entityId`, `body` (Markdown), `createdBy` | Exported to `.sati/comments/`, merged like notes, in FTS |

Each change bumps the snapshot `schemaVersion` with an automatic migration, as the Versioning
section requires. Old binaries already refuse writes to a newer schema.

## Screens (Phase 7a)

- **My work:** assigned to me, then due this week, then waiting for my approval.
- **Board:** a "New task" button; cards show due date, assignee initials and checklist progress;
  overdue in red. Approve and "send back with a reason" buttons on cards in review.
- **Task panel:** due date, assignees, checklist, comments, labels and priority; take over or
  release a claim (logged).
- **Roadmap:** create and edit milestones; drag to change the target date.
- **Notes:** edit, tags, pin, `[[` links to tasks and decisions, backlinks.
- **Settings:** people (name, initials, colour), language, review gate, project kind.

## Sequencing and effort (estimate)

| Step | Scope | Estimate |
| --- | --- | --- |
| Phase 5b open items | the open list in PLAN.md | 1 week |
| 7a Two ways to work | UI and agent parity, note tools, kind, people, due/assignee/checklist, comments, My work, plain words, Khmer, parity test | 3.5 weeks |
| 7b Review and changelogs | release notes, `changes`, brief "since last session", changelog, feature list, review without git, Changes page | 1.5 weeks |
| 7c Brain for agents | templates, calendar export | 0.5 week |
| Phase 8 Knowledge brain | cards with facts, recall, compact answers, private memory, token ledger, Memory page | 2.5 weeks |
| Phase 6 Hosted | as planned (Postgres, auth, sync, remote MCP) | 5–6 weeks |
| 7d Without a terminal | team server UI, email sign-in, inbox and notifications, launcher, link attachments | 2–3 weeks |

## How we will know it works

| Metric | Target |
| --- | --- |
| A non-developer plans an event from a template | under 10 minutes, no terminal |
| Records created by people (not agents) per week | grows every week for the first month of the trial |
| "Why did we…?" answered from a decision or note | 8 of 10 questions in the trial |
| Developer budgets (brief size, CLI p95, claim p95) | unchanged |

## Risks

| Risk | Mitigation |
| --- | --- |
| Scope creep into a full PM suite | Positioning rule in PLAN Phase 7; new requests go to `docs/ideas.md` first |
| Plain-word UI drifts from CLI terms and confuses developers | One glossary page; tooltips show the CLI term |
| Comments and assignees bloat the agent brief | Comments never in the brief; brief tests keep the 1,500-token cap |
| Non-developers edit `.sati/` JSON by hand in a general project without git | General projects have no snapshot by default; export is opt-in |
| Hosted mode slips, so office users never get access | 7a–7c still pay off locally; the desktop launcher covers one-person use |
