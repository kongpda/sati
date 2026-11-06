import { defineConfig, devices } from "@playwright/test";

// Browser tests for the local board. Each spec file starts its own `sati ui` on a temp repo
// (see ui/server.ts), so they need a built CLI and UI: run `pnpm build` first.
export default defineConfig({
  testDir: "ui",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
