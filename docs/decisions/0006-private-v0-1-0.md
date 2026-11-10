# 0006. Release v0.1.0 for private use, without npm

- Status: accepted (2026-11-10, owner decision)
- Date: 2026-11-10

## Context

The code for v0.1.0 is done and CI is green on Linux, macOS and Windows. The owner wants to use
it privately first and not publish to npm yet. The release workflow ran on every push to `main`:
once no changesets are pending, `changesets/action` runs `changeset publish`, which would try
to publish to npm.

## Decision

- Bump `@kongpda/sati` to 0.1.0 with `changeset version` and tag the commit `v0.1.0`.
- Install it from the packed tarball (`npm pack` in `packages/cli`, then `npm install -g` the
  `.tgz`). Nothing goes to npm.
- The release workflow runs only by hand (`workflow_dispatch`) until the owner decides to
  publish, so a push to `main` cannot start a publish.

## To publish later

Add an npm automation token as the `NPM_TOKEN` repo secret, restore the `push` trigger on
`main`, and run the workflow. Either allow GitHub Actions to create pull requests or open the
Version PR by hand.
