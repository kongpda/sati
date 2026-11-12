import { defineConfig } from "vitest/config";

// Windows and the macOS CI runners spawn processes and open SQLite files several times slower
// than Linux, so tests there get more time. Locally 15 s: several agents run this suite at the
// same time on one machine, and under that load the tests that spawn git went past 5 s.
// The empty global git config and the temp folder come from `scripts/test-tmp.ts`. The system
// config is ignored here, and the identity variables stand in for the `user.name` and
// `user.email` a developer's config would have supplied.

export default defineConfig({
  test: {
    testTimeout: process.platform === "win32" || process.env.CI ? 30_000 : 15_000,
    setupFiles: ["test/setup-registry.ts"],
    globalSetup: ["../../scripts/test-tmp.ts"],
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "tester@example.test",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "tester@example.test",
    },
  },
});
