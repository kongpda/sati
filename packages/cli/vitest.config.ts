import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Windows and the macOS CI runners spawn processes and open SQLite files several times slower
// than Linux, so tests there get more time. Locally the default 5 s still catches hangs.
// Tests run `sati init` in temp repos, which chains into `core.hooksPath`. Ignoring the global
// and system git config keeps a developer's own hooks folder (and its hooks) out of the run;
// the identity variables stand in for the `user.name` and `user.email` it would have supplied.
// An empty file, not `os.devNull`: git for Windows cannot open `\\.\nul` as a config file.
const emptyGitConfig = join(mkdtempSync(join(tmpdir(), "sati-gitconfig-")), "gitconfig");
writeFileSync(emptyGitConfig, "");

export default defineConfig({
  test: {
    testTimeout: process.platform === "win32" || process.env.CI ? 30_000 : 5_000,
    setupFiles: ["test/setup-registry.ts"],
    env: {
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "tester@example.test",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "tester@example.test",
    },
  },
});
