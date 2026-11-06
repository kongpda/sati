import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { CLI_NAME } from "../core/src/name.ts";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The product name lives in core; the board names commands with it.
  define: { __CLI_NAME__: JSON.stringify(CLI_NAME) },
  build: { outDir: "dist", emptyOutDir: true, cssCodeSplit: false },
});
