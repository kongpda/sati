// Copies the built web UI into dist/ui, so the published package serves `sati ui` on its own.
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../../ui/dist", import.meta.url));
const to = fileURLToPath(new URL("../dist/ui", import.meta.url));
if (!existsSync(`${from}/index.html`)) {
  console.error(`The web UI is not built: ${from}/index.html is missing.`);
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
