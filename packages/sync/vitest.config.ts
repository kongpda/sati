import { defineConfig } from "vitest/config";

// The property tests run hundreds of cases each. On the Windows CI runners they passed the
// default 5 s on a slow day (run for b4469b1), so tests there get more time, as in store-sqlite.
export default defineConfig({
  test: { testTimeout: process.platform === "win32" ? 30_000 : 5_000 },
});
