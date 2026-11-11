import { defineConfig } from "vitest/config";

// The tests make repos and databases in the temp folder; the run removes them at the end.
export default defineConfig({
  test: { globalSetup: ["../../scripts/test-tmp.ts"] },
});
