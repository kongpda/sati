import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAME, CONFIG_DIR, SatiError } from "@sati/core";
import { defineCommand } from "citty";
import { closeRuntime, int, openRuntime, printError } from "../runtime.js";
import { createUiApp, listenUi, sessionToken, type UiRuntime } from "../ui/server.js";

/** Writes come in bursts from the board; export once the burst is over. */
const EXPORT_DEBOUNCE_MS = 2000;

/**
 * The built UI ships next to the bundle in `dist/ui`. In this repo, `src` runs (tests, tsx) fall
 * back to `packages/ui/dist`. Never look under the working directory: a repo could plant its own
 * page there and it would run with the session cookie.
 */
export function uiDir(here = dirname(fileURLToPath(import.meta.url))): string {
  const candidates = [join(here, "ui"), join(here, "../../../ui/dist")];
  const found = candidates.find((dir) => existsSync(join(dir, "index.html")));
  if (!found) {
    throw new SatiError("USAGE", "The web UI has not been built.", {
      hint: "From the repo, run `pnpm build`.",
    });
  }
  return found;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { cmd: "open", args: [url] }
      : process.platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] };
  execFile(command.cmd, command.args, () => undefined);
}

export default defineCommand({
  meta: { name: "ui", description: "Open the local board in a browser" },
  args: {
    port: { type: "string", description: "Port on 127.0.0.1 (default: a free port)" },
    // citty reads `--no-open` as `open: false`, so the flag is declared as `open`.
    open: {
      type: "boolean",
      default: true,
      description: "Open a browser (--no-open prints the URL only)",
    },
  },
  run: async ({ args }) => {
    try {
      // Check the port before opening the database: a bad flag should fail fast and cleanly.
      const port = int(args.port, "port") ?? 0;
      if (args.port !== undefined && (port < 1 || port > 65535)) {
        throw new SatiError("USAGE", "Port must be between 1 and 65535.");
      }
      const rt = await openRuntime();
      const token = sessionToken();
      // Git mode keeps `.sati/` current after UI writes, as CLI commands and the MCP server do.
      let flush = async () => {};
      let ui: UiRuntime = { ctx: rt.ctx };
      if (rt.project.mode === "git") {
        const { afterWrites, exportSnapshot } = await import("@sati/sync");
        const dir = join(rt.location.root, CONFIG_DIR);
        const synced = afterWrites(
          rt.ctx.store,
          EXPORT_DEBOUNCE_MS,
          async () => {
            await exportSnapshot(rt.ctx, dir);
          },
          (err) => printError(err, false),
        );
        flush = synced.flush;
        ui = { ctx: { ...rt.ctx, store: synced.store }, dataStore: rt.ctx.store };
      }
      const app = createUiApp(ui, token, uiDir());
      const server = await listenUi(app, port);
      const url = `http://127.0.0.1:${server.port}/session?token=${token}`;
      process.stdout.write(`${CLI_NAME} ui on ${url}\n`);
      if (args.open !== false) openBrowser(url);
      const stop = () => {
        void server
          .close()
          .then(flush)
          .finally(() => closeRuntime());
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } catch (err) {
      process.exitCode = printError(err, false);
      await closeRuntime();
    }
  },
});
