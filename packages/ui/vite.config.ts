import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { PRODUCT_NAME } from "../core/src/name.ts";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The product name lives in core; the board's title and brand use it.
  define: { __PRODUCT_NAME__: JSON.stringify(PRODUCT_NAME) },
  // \`license\` writes the bundled packages' license texts to dist/licenses.md, shipped with the CLI.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    license: { fileName: "licenses.md" },
  },
});
