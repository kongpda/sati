---
"@kongpda/sati": minor
---

Coordination signals between agents and people. An agent can say it waits on a person (`sati wait`, `task_update --needs-input`, or automatically from Claude Code's permission prompts), and people see it under "Needs you" in the brief and on My work, with "I answered". Blocked tasks carry a reason. Work sent for approval is pinned to its commit, and an approval is refused if the branch moved since. The brief and the Stop hook warn about files another agent's worktree also changed without a lock, and about conflicts with the base branch. Claims of agents whose MCP server has exited are released early. Handoffs can be addressed (`--to`), come back with the next claim and are marked read. `sati activity --after <id>` reads the log from a cursor, the board's live updates resume after a dropped connection, and `sati doctor` lists finished worktrees you can remove.
