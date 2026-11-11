# 0009. Sharing a project through a synced folder, without git

- Status: accepted (2026-11-11, the owner chose this item; the design below is the smallest that meets it)
- Date: 2026-11-11

## Context

An office or marketing team has no git. Its project folder lives in Dropbox, OneDrive, iCloud
Drive, Google Drive or on a file server. A standalone project there is one person's memory: the
database is in `~/.sati/projects/` on that person's machine and nothing else leaves it. Phase 6
(the hosted server) is the real answer for a team and is deferred until v1.0 has been tried.

Putting the SQLite file in the synced folder is not an option: a sync app copies the file while
it is written, which corrupts it. `doctor` already warns about that.

## Decision

A standalone project can be shared. `sati init --share` (new project) or `sati sync share` (an
existing one) sets `"share": true` in `.sati/sati.config.json`. Then:

- **Snapshot in the folder.** The same one-file-per-record snapshot that git mode commits is
  written under `.sati/` after every command that wrote. The sync app carries the files.
- **Database outside it.** Unchanged: `~/.sati/projects/<projectId>.db` on each machine. Private
  notes and cards never leave that file, as in git mode.
- **Joining.** A second person opens the synced folder and runs `sati init`. The config is
  already there, so they get the same project id and the records in the snapshot.
- **Loading changes.** There are no git hooks to say "the files changed". Each command first
  compares the size and modified time of every record file with what this machine last saw,
  and imports only the files that differ. The board and the MCP server do the same every 5
  seconds. The list of what was seen is a file next to the database, not in the folder.
- **Conflicted copies.** When two people change one record before the sync app meets, the app
  keeps one file and writes the other under a new name (`tsk_… (conflicted copy).json`,
  `tsk_… 2.json`, `tsk_….sync-conflict-….json`). Sati reads the copy, merges it into the record
  field by field with the same stamps the git merge driver uses, writes the merged record and
  deletes the copy. A copy it cannot read is left alone and named in a warning.
- **A bad file does not stop work.** A file that is half synced or not valid fails that import
  with a warning; the command still runs, and the file is tried again next time.

No new mode: the project is still `standalone`. A `share` flag changes where records go, not
what the project is, and every place that asks "is there git here" stays right.

## Limits, stated to the user

- Changes arrive as fast as the sync app moves files: seconds to minutes, not live.
- A task claim travels with the task record, so two people can claim one task inside that
  window. The merge keeps the later claim. File locks are not in the snapshot at all. Live
  claims and locks across people need the server (Phase 6).
- Every machine needs the same sati version or newer to read the files; an older one stops with
  "Invalid config" because it does not know `share`.
- One unreadable record file holds back the other changed files of that import until it is fixed
  or deleted. The warning names it.

## Rejected

- **Database in the synced folder.** Corrupts; see Context.
- **A fourth mode `folder`.** `mode` is read in about forty places to mean "git or not". A flag
  is one field and no migration.
- **Import everything on every command.** Simple, but a 5,000-record project would read 5,000
  files to print one line. The size-and-time list reads only what changed.
- **A file watcher.** Sync apps write in bursts and through temp files, watchers differ per
  platform, and a one-shot command cannot use one. A 5-second check costs one `stat` per file.
