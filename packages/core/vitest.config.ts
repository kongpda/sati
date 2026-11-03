import { defineConfig } from "vitest/config";

// PLAN Phase 1: core keeps 90%+ unit test coverage. `pnpm test` fails below it.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
