# @kongpda/sati

## 0.0.1

### Patch Changes

- e0cd462: Add a README to the npm package and a docs guide: quick start, agent workflow, guard rules and FAQ.
- 583e71a: Hints now name the real `--features` flag of `decision record`. The old `--feature` hint was ignored, so the decision was linked to no feature and the guard kept blocking.
- 0198a0e: `sati init` writes `.sati/sati.config.json` on Windows again.
- 52a64cc: `sati init` reports file paths with `/` on Windows too, so its `--json` output is the same on every platform.
- 6b55d5e: First publish: `sati --version`.
- bb9de0f: Fix: merging `.sati/` snapshots no longer brings back a claim on a task that was completed on the other branch.
- a9eda0a: The board renders fenced `mermaid` blocks in notes, decisions and task bodies as diagrams.
- 215da87: `sati serve` listens on a named pipe on Windows, where a socket file next to the database is not allowed.
- 3dea1f6: Board fixes: a plain click on a card opens it again, a refused bulk move puts back only the cards that failed, the board stays virtualised with thousands of cards, and pages have a main landmark and headings for screen readers.
- 580dcdb: The board: filters show only on the board, empty columns and empty filter results say so, and empty-state hints name the right commands.
- ad1a1eb: `sati ui --no-open` prints the sign-in URL without opening a browser, and stopping the UI server no longer waits on open event streams.
- ecfb366: The board top bar fits a 375 px phone screen.
- b56fe13: The UI server compares the session token in constant time and refuses request bodies over 1 MB.
- 8395239: `sati ui` now works from the installed npm package: the built board ships inside the CLI's `dist/ui`. It no longer looks for a page under the working directory, so a repo cannot plant its own page and run it with the session cookie.
