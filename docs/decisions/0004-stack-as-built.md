# 0004. Record the stack as built: no router, UI kit, editor or logger libraries

- Status: accepted (2026-11-10)
- Date: 2026-11-10

## Context

The `PLAN.md` tech-stack table was written before Phase 4. It names six libraries that the
board and the local server never took on: TanStack Router, shadcn/ui with Radix, `cmdk`,
Tiptap, `@hono/zod-openapi` and `pino`. None is a dependency of any package. AGENTS.md says a
stack change needs an ADR, so the table and the code must agree, and this record says why they
differ. The 2026-11-10 review (WP8) found the drift.

## Decision

The table lists what is built. Each planned library was replaced as follows:

| Planned | Built instead | Why |
| --- | --- | --- |
| TanStack Router | A small router in `packages/ui/src/app.tsx` on `history.pushState` | The board has a handful of pages. A router library added bundle weight for no typed-route gain. |
| shadcn/ui and Radix | Plain React components and Tailwind CSS v4 with design tokens in `styles.css` | The few dialogs and menus are built and covered by Playwright and axe tests. No generated component copies to keep up to date. |
| `cmdk` | The command palette in `app.tsx` | Same reason: one small palette, keyboard flows tested end to end. |
| Tiptap | A textarea editor and the Markdown renderer in `markdown.tsx` | Notes and bodies are stored as Markdown. A rich-text editor would convert in both directions and weigh more than the rest of the board. |
| `@hono/zod-openapi` | A hand-written OpenAPI 3.1 document in `packages/cli/src/ui/server.ts` | The local API is small and read mostly by the board. Zod still validates every input in `core`. |
| `pino` | No logger yet | Planned for the hosted server (Phase 6). The local CLI writes errors to stderr. |

The hosted rows (PostgreSQL, Better Auth, Docker image) stay in the table, marked Phase 6.

## Consequences

The board ships less JavaScript and has fewer dependencies to audit. The
board's own router, palette and editor must be maintained and tested here. If a later phase
needs one of these libraries, it needs a new ADR.

## Alternatives considered

- Add the libraries to match the plan: more install weight and audit surface for features
  already built and tested.
- Leave the table as it was: it misleads contributors and agents about the stack.
