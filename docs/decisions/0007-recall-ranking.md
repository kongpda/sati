# 0007. Rank recall by recency and by files being edited

- Status: accepted (2026-11-11, owner asked for the idea to be taken from fff)
- Date: 2026-11-11

## Context

`recall` ordered its results by text match (FTS5 BM25) alone. Two records that match a question
about equally came back in an order that says nothing about which one is useful now: a note from
last year could sit above the one written this morning, and the card of the file an agent is
editing had no advantage over any other card.

The file finder fff (github.com/dmtrKovalenko/fff) ranks by "frecency" (how often and how
recently a file was opened) and by git status (changed files first). It was reviewed on
2026-11-11 as a possible dependency and rejected: it needs a native addon and prebuilt binaries,
and sati matches exact globs from `git ls-files`, so fuzzy file search has no use inside it. Its
ranking idea does fit.

## Decision

`recall` keeps text match as the base order and adds a small lift:

- +2 places for a record updated in the last 7 days, +1 in the last 30 days.
- +3 places for a context card whose path covers a file that differs from HEAD.
- Records that hold every word of the question always come before those that hold only some.

The lift only reorders near-ties. It needs no new table and no write on read: `updatedAt` is
already stored, and the repo port already reports uncommitted files (`RepoFile.dirty`).

## Not done

- No access counting ("how often was this recalled"). It would turn every read into a write and
  a line in the activity log, and reads must stay free of side effects.
- No fuzzy matching and no fff dependency.

## Consequences

The order of `recall` results can change from one day to the next for the same question. The
token budget, the fields and the `stale` flag are unchanged.
