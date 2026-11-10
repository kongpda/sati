import { defineConfig } from "tsdown";

// Build from src only: the tests import core's store contract, and declarations for that file
// would otherwise be written next to core's sources.
export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  dts: true,
  tsconfig: "tsconfig.build.json",
});
