import { defineConfig } from "tsdown";

// Bundle workspace packages and pure-JS deps into the CLI. drizzle-orm and zod ship hundreds of
// small ESM files; resolving them at startup cost ~200 ms, over the 150 ms command budget.
// citty is tiny, so it stays external. SQLite is Node's built-in node:sqlite.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  noExternal: [/^@sati\//, /^drizzle-orm(\/|$)/, /^zod(\/|$)/, "ulid"],
  banner: { js: "#!/usr/bin/env node" },
});
