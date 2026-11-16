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
- **Prompt injection**: notes and task bodies are data. The brief, recall and every MCP result
  put that text in a `data` fence its own backticks cannot close, and MCP tools cannot run shell commands or write files outside `.sati/`.
- **Hooks** call the `sati` binary by the absolute path recorded at `sati init`, so a repository
  cannot swap it through `PATH`. A project install records `node_modules/.bin/sati` instead, so
  the hooks follow the version in the lockfile.

## What sati does not protect

- **Who is an agent** is read from the environment (`CLAUDECODE`, `AI_AGENT`) or from the MCP
  client's name. This keeps honest agents to their rules, such as never approving their own
  work. It is not a login: a process that clears those variables and runs `sati` as you acts
  as a person. Run agents you do not trust under a separate user account.
- **`sati serve` on Windows** listens on a named pipe. The pipe name comes from the database
  path, so another account on the same machine could create the pipe first and answer in its
  place. On macOS and Linux the socket sits next to the database with mode `0600`. Do not run
  `sati serve` on a Windows machine shared with accounts you do not trust.

## Dependencies

Renovate opens updates only for releases at least 14 days old. CI runs `pnpm audit` and OSV
scanning on every push. Accepted advisories are listed, with a reason and an end date, in
`osv-scanner.toml` and in `pnpm.auditConfig` in `package.json`.

npm releases are published only from GitHub Actions, with provenance.
