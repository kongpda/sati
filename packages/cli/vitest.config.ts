import { devNull } from "node:os";
import { defineConfig } from "vitest/config";

// Windows CI runners spawn processes and open SQLite files several times slower than Linux
// and macOS, so tests there get more time. Elsewhere the default 5 s still catches hangs.
// Tests run `sati init` in temp repos, which chains into `core.hooksPath`. Ignoring the global
// and system git config keeps a developer's own hooks folder (and its hooks) out of the run;
// the identity variables stand in for the `user.name` and `user.email` it would have supplied.
export default defineConfig({
  test: {
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    env: {
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "tester@example.test",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "tester@example.test",
    },
  },
});
