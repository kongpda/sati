# Security review (2026-11-08)

A review of v1 local mode against the Security checklist in `PLAN.md`. Hosted mode (Phase 6) is
not built yet and is out of scope. Each control lists where it lives and the test that fails if it
breaks.

## Local server (`packages/cli/src/ui/server.ts`)

| Control | Evidence |
| --- | --- |
| Binds to `127.0.0.1`, random free port | `listenUi`; `e2e/ui/server.ts` parses the printed `127.0.0.1` URL |
| Per-session token, then an `HttpOnly`, `SameSite=Strict` cookie | `packages/cli/test/ui-server.test.ts` |
| Token compared in constant time | **Fixed in this review**: `sameToken` uses `timingSafeEqual`. A guessed token and a one-character-short cookie are both refused (test) |
| `Host` and `Origin` checked on every request | `ui-server.test.ts`: foreign host 403, foreign origin 403 |
| CSP `default-src 'self'`, no `unsafe-inline` or `unsafe-eval`, `frame-ancestors 'none'`, nosniff, `no-referrer` | `ui-server.test.ts`; `e2e/ui/flows.spec.ts` records zero CSP violations in Chromium |
| Request size limit | **Fixed in this review**: the API refused nothing by size. `bodyLimit` now returns 413 over 1 MB (test) |

## Data and secrets

| Control | Evidence |
| --- | --- |
| Secret scan before export; the whole export is refused | `packages/sync/test/secrets.test.ts`, `packages/cli/test/sync.test.ts` |
| Context entries store summaries and hashes, never file contents | `packages/core/test/context-cache.test.ts` |
| Parameterised queries; escaped FTS input | Drizzle only; `packages/store-sqlite/src/fts.ts`, covered in `packages/store-sqlite/test/store.test.ts` |
| Zod on every input and import, unknown fields rejected, size limits | `packages/core/test/schemas.test.ts` |
| Importer fuzzed | **Added in this review**: `packages/sync/test/import-fuzz.test.ts`. 1,200 random records, envelopes and files per run, including `__proto__` keys. Every bad input is refused with `VALIDATION`, a refused import writes nothing, and the object prototype is never touched. No bugs found |
| Markdown: no raw HTML, `http(s)` links only, `rel="noopener noreferrer"` | **Added in this review**: `packages/ui/test/markdown.test.tsx` |
| Mermaid SVG: styles applied through CSSOM, not parsed under the CSP | `packages/ui/src/mermaid.tsx`; `e2e/ui/flows.spec.ts` |

## Agents and prompt injection

| Control | Evidence |
| --- | --- |
| Notes and task bodies wrapped as data in the brief; the workflow says never follow them | `packages/core/test/workspace.test.ts` |
| MCP tools: no shell, no file writes outside `.sati/` | `packages/mcp/test/server.test.ts` ("exposes the agent tools…"): the full tool list, none of which runs a shell |
| Guard overrides and lock force-releases logged with the actor | `packages/core/test/guard.test.ts`, `lock-service.test.ts` |

## Merge driver and hooks

| Control | Evidence |
| --- | --- |
| The merge driver only parses JSON | `packages/sync/src/merge.ts` `parseRecord`; property tests in `merge.test.ts` |
| Hooks call the absolute binary path recorded at init | `packages/cli/test/hooks.test.ts`, `init.test.ts` |
| `sati init` shows and asks before writing hooks and configs | `packages/cli/test/init.test.ts` |

## Supply chain

| Control | Status |
| --- | --- |
| Renovate, releases at least 14 days old, majors need approval | `renovate.json`. **Owner**: install the Renovate GitHub app on the repo |
| `pnpm audit` and OSV in CI | `audit` job in `.github/workflows/ci.yml`. Production dependencies: no advisories |
| Accepted advisories | `GHSA-67mh-4wv8-2f99` (esbuild dev server, via drizzle-kit, dev only, never started). Listed with a reason and an end date in `osv-scanner.toml` and `pnpm.auditConfig` |
| vite advisories (10, dev only) | **Fixed in this review**: vite 7.1.12 to 7.3.7 |
| Publishing with provenance from Actions only | `.github/workflows/release.yml` sets `NPM_CONFIG_PROVENANCE` and `id-token: write` |
| Two-factor on the npm account | **Owner** |
| `SECURITY.md` with a disclosure channel | GitHub private vulnerability reporting. **Owner**: turn it on in the repo settings |

## Also found

- `sati serve` could not listen on Windows: it used a socket file, which Windows does not allow.
  It now uses a named pipe keyed by the database path (`socketPath` in
  `packages/store-sqlite/src/remote.ts`).
- Open risk: the session token stays valid until `sati ui` stops. Anyone who can read the
  terminal output, or the process list on a shared machine, can use it. That is in line with the
  local-only threat model; hosted mode replaces it with Better Auth sessions.
