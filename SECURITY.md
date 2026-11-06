# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub:
**Security → Report a vulnerability** on this repository
(private vulnerability reporting). Do not open a public issue.

Include what you found, how to reproduce it, and the version (`sati --version`). You will get
an answer within 3 working days. Fixes ship as a patch release, with credit if you want it.

## Supported versions

Only the latest minor release of `@kongpda/sati` gets security fixes.

## What sati protects

- **The local UI server** binds to `127.0.0.1` only, needs a one-time token that becomes an
  `HttpOnly`, `SameSite=Strict` cookie, checks `Host` and `Origin` on every request, and sends a
  strict CSP with no inline scripts or styles.
- **Secrets**: every record is scanned before it is exported to `.sati/`. An export that would
  commit an API key, token, private key or `.env` line is refused as a whole.
- **Imported files** from `.sati/` are parsed as JSON only, validated with strict schemas and size
  limits, and imported all or nothing. The importer is fuzzed in CI.
- **Prompt injection**: notes and task bodies are data. The brief marks them as such, and MCP
  tools cannot run shell commands or write files outside `.sati/`.
- **Hooks** call the `sati` binary by the absolute path recorded at `sati init`, so a repository
  cannot swap it through `PATH`.

## Dependencies

Renovate opens updates only for releases at least 14 days old. CI runs `pnpm audit` and OSV
scanning on every push. Accepted advisories are listed, with a reason and an end date, in
`osv-scanner.toml` and in `pnpm.auditConfig` in `package.json`.

npm releases are published only from GitHub Actions, with provenance.
