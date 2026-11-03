import { defineConfig } from "tsdown";

// `name` is its own entry so the CLI can print `--version` without loading the core.
export default defineConfig({ entry: ["src/index.ts", "src/name.ts"], format: "esm", dts: true });
