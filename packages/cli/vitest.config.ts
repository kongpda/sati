import { defineConfig } from "vitest/config";

// Windows CI runners spawn processes and open SQLite files several times slower than Linux
// and macOS, so tests there get more time. Elsewhere the default 5 s still catches hangs.
export default defineConfig({
  test: { testTimeout: process.platform === "win32" ? 30_000 : 5_000 },
});
