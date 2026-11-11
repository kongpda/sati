---
"@kongpda/sati": patch
---

A pull no longer drops a local edit that was not exported yet: import merges a record field by field whenever the database and the file changed apart, at any version. The snapshot reader accepts a byte-order mark and skips copies a file-sync app made (`name (1).json`, conflicted copies) with a warning. Snapshot files are flushed before the rename. `sati serve` clients no longer hang after a failed commit, and give up on a daemon that does not answer in 60 seconds. NTFS and exFAT disks on Linux (`fuseblk`) count as local. `sati init` and `sati doctor` warn when the database is inside a Dropbox, OneDrive, Google Drive, iCloud or Box folder.
