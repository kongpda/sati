# Guard rules

The guard stops an agent from breaking shipped features or editing paths another agent has
locked. It is read-only: it reports findings and sets an exit code. It never changes files.

## Layers

| Layer | Where it runs | What it catches |
| --- | --- | --- |
| 1. Rules | The managed rules block in `AGENTS.md`, `CLAUDE.md` and others | Tells agents to run `feature_check` and take locks before risky edits |
| 2. Editor hook | Claude Code `PreToolUse` hook (`sati guard --hook`) | Blocks an edit before it is written (exit 2) |
| 3. Git hooks | `pre-commit` (`sati guard --staged`) and `pre-push` | Blocks a commit or push with a blocked change |
| 4. CI | `sati guard --range origin/main...HEAD` | Blocks a pull request, even if local hooks were skipped |

`sati init` sets up layers 1 to 3. Add layer 4 to your CI yourself (see below).

## Rules

| Rule | Level | When |
| --- | --- | --- |
| `locked` | blocked | A changed path is inside another agent's exclusive lock |
| `locked-shared` | warning | A changed path is inside another agent's shared lock |
| `protected-delete` | blocked | A change deletes a file of a shipped, protected feature |
| `protected-gutted` | blocked | A change removes more than `maxRemovalRatio` of the changed lines of a shipped, protected feature |
| `renamed-out` | warning | Files were moved out of a shipped feature's paths |
| `shipped-touched` | warning | Any other change to a shipped feature |

`maxRemovalRatio` defaults to `0.5`. Set it in `.sati/sati.config.json`:

```json
{ "guard": { "maxRemovalRatio": 0.3 } }
```

Your own locks never block you. Features that are not `shipped` are not guarded.

## Commands

```bash
sati guard --staged                     # the staged diff
sati guard --paths src/a.ts,src/b.ts    # these paths, as edits
sati guard --range origin/main...HEAD   # a commit range
sati review origin/main...HEAD          # features touched, decisions and guard warnings
```

`sati guard` exits `0` when nothing is blocked and `10` when something is.

## Allowing a blocked change

A protected feature may lose behaviour when a decision says why. Record one that lists the
feature, then retry:

```bash
sati decision record "Drop the legacy export" \
  --decision "Remove the CSV exporter; the JSON export replaces it." \
  --features <feature-id>
```

The newest decision that lists a feature allows the change. The finding then shows as a warning
that names the decision.

For a lock, ask the holder, or wait for the lease to end. To take another agent's lock, run
`sati lock release <id> --force`. This is logged.

To skip the guard once, set `SATI_GUARD=off`. The override is logged in the activity log.

## Known limits

The guard is a check on the usual paths, not a sandbox. The `pre-commit` guard on the staged diff
is the backstop for anything the editor hook cannot see.

- **Binary files** have no line counts, so `protected-gutted` never applies to them. Deleting one
  still counts as `protected-delete`.
- **Truncating a file** with the Write tool or `> file` only warns in the editor hook. The staged
  check sees the removed lines: an emptied file is blocked like a delete, and a cut over the
  ratio is blocked as `protected-gutted`.
- **Shell commands the hook does not parse**: `xargs rm`, `find -delete`, `eval`, scripts run by
  other interpreters, paths held in variables, `git -c alias.x=...` and `git commit-tree`. The
  staged check still sees what they change.
- **`SATI_GUARD=off git commit`** is allowed on purpose. It is the documented override, and it is
  logged.
- **Accepted gaps**: removing a feature over many small commits that each stay under the ratio,
  moving files out through a symlink, and `git commit -m "--no-verify"` being blocked as if it
  were the flag.
- **A rename out of a protected feature** only warns (`renamed-out`). This is on purpose: the file still exists, and blocking would stop normal refactors. Update the feature's paths with `feature_upsert` after the move.

## Locks

```bash
sati lock acquire 'src/billing/**' --reason "Refactor invoices" --task <task-id>
sati lock acquire 'docs/**' --shared     # overlaps only warn
sati lock list
sati lock release <id>
```

Locks are exclusive unless you pass `--shared`. A lock has a lease (`--lease <minutes>`, default
from the project settings). A lock tied to a task with `--task` is released when the task is
completed.

## CI

Run the guard on every pull request. Check the changes against the `.sati/` snapshot of the base
branch, not the branch itself: a pull request must not be able to unprotect a feature and
delete it in the same change.

```yaml
guard:
  runs-on: ubuntu-latest
  if: github.event_name == 'pull_request'
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0
    - uses: actions/setup-node@v4
      with:
        node-version: 24
    # Until @kongpda/sati is on npm, use the project's own copy: `npm ci`, then `npx sati`.
    - run: npm install -g @kongpda/sati
    - shell: bash
      env:
        PR_BASE: ${{ github.event.pull_request.base.sha }}
        PR_HEAD: ${{ github.event.pull_request.head.sha }}
      run: |
        base=$(git merge-base "$PR_BASE" "$PR_HEAD")
        if ! git cat-file -e "$base:.sati/sati.config.json" 2>/dev/null; then
          echo "The base branch has no sati snapshot yet."
          exit 0
        fi
        git restore --source="$base" --worktree -- .sati
        sati init --mode git --yes --tools ''
        sati sync import
        sati guard --range "$base..$PR_HEAD"
```

Stealth mode commits nothing, so it has no CI layer.
