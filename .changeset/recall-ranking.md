---
"@kongpda/sati": minor
---

`recall` ranks better and every command starts faster.

- `recall` lifts records written in the last week or month, and the card of a file that has
  uncommitted changes, above older records that match the question equally well.
- The current branch is read from the `HEAD` file, which saves one `git` start per command.
- Hashing changed files no longer slows down with the number of files in the repository.
