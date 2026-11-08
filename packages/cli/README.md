# sati

Local-first memory, task and feature manager for AI coding agents.

Several agents (Claude Code, Codex, Cursor, Gemini CLI) can work in one repository and share
the same tasks, features and decisions. sati keeps them from taking the same task, from editing
paths another agent has locked, and from deleting features that already ship.

- Tasks with claims and leases, so two agents never work on the same task.
- Features with protected paths, enforced by a guard in the editor, git hooks and CI.
- Decisions that record why code was removed or an approach was rejected.
- An MCP server and a CLI with the same operations; `--json` on every command.
- A local web board (`sati ui`).
- Data stays on your machine. In git mode a `.sati/` snapshot is committed and merged by a git
  merge driver.

## Install

Node.js 24.15 or newer:

```bash
cd my-project
npm install -D @kongpda/sati   # or: pnpm add -D, yarn add -D
npx sati init
```

The agent configs and git hooks then start `node_modules/.bin/sati`, and every teammate gets the
version in the lockfile. For stealth mode or a repo without a `package.json`, use
`npm install -g @kongpda/sati` and run `sati init`.

## Use

```bash
sati task create "Add a health check endpoint"
sati next           # claim the top ready task
sati brief          # what an agent sees at session start
sati ui             # the web board
sati doctor         # health checks
```

## Docs

- [Quick start](https://github.com/kongpda/sati/blob/main/docs/guide/quick-start.md)
- [Agent workflow](https://github.com/kongpda/sati/blob/main/docs/guide/agent-workflow.md) ([general projects](https://github.com/kongpda/sati/blob/main/docs/guide/agent-workflow-general.md))
- [Guard rules](https://github.com/kongpda/sati/blob/main/docs/guide/guard.md)
- [FAQ](https://github.com/kongpda/sati/blob/main/docs/guide/faq.md)
- [Glossary](https://github.com/kongpda/sati/blob/main/docs/guide/glossary.md)

## License

MIT. The package also bundles third-party code; their licenses are in `dist/THIRD_PARTY_LICENSES.md` and `dist/ui/licenses.md`.
