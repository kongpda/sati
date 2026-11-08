import { defineConfig } from "tsdown";

// Every runtime package is a devDependency, so tsdown bundles it and `npm install` fetches only
// this package: about 3 MB instead of 29. Only the code used ends up in the bundle, split per
// command, so `sati --version` loads none of it. SQLite is Node's built-in node:sqlite.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
});
