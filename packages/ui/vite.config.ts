import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { PRODUCT_NAME } from "../core/src/name.ts";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The product name lives in core; the board's title and brand use it.
  define: { __PRODUCT_NAME__: JSON.stringify(PRODUCT_NAME) },
  build: { outDir: "dist", emptyOutDir: true, cssCodeSplit: false },
});
