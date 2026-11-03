import { defineConfig } from "tsdown";

// Bundle internal workspace packages into the single CLI file; keep npm deps external.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  noExternal: [/^@brain\//],
  banner: { js: "#!/usr/bin/env node" },
});
