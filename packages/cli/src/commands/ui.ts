import { execFile } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAME, CONFIG_DIR, type ProjectKind, SatiError } from "@sati/core";
import { defineCommand } from "citty";
import { selfCommand } from "../hooks.js";
import { launcherFile } from "../launcher.js";
import {
  closeRuntime,
  exportWritten,
  int,
  openRuntime,
  printError,
  writeConfigKind,
} from "../runtime.js";
import { readTemplateFiles } from "../templates.js";
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
    shortcut: {
      type: "string",
      description:
        "Write a file into this folder (such as ~/Desktop) that opens the board on a double click, then exit",
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
      if (args.shortcut !== undefined) {
        const dir = resolve(args.shortcut);
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          throw new SatiError("USAGE", `${dir} is not a folder.`);
        }
        const self = selfCommand(rt.location.root);
        const made = launcherFile(process.platform, self, rt.location.root, rt.project.name);
        const file = join(dir, made.file);
        writeFileSync(file, made.body, { mode: made.mode });
        process.stdout.write(`Wrote ${file}. Double-click it to open the board.\n`);
        // A copy fetched by npx lives in a cache that is cleared; the launcher would then fail.
        if (self.some((w) => /[\\/]_npx[\\/]/u.test(w))) {
          process.stderr.write(
            `hint: this ${CLI_NAME} runs from the npx cache. Install it (npm install -g) and write the launcher again.\n`,
          );
        }
        await closeRuntime();
        return;
      }
      const token = sessionToken();
      // Git mode keeps `.sati/` current after UI writes, as CLI commands and the MCP server do.
      let flush = async () => {};
      const onKind = (kind: ProjectKind) => writeConfigKind(rt.location.root, kind);
      const templates = () => readTemplateFiles(rt.location.root);
      let ui: UiRuntime = { ctx: rt.ctx, onKind, templates };
      if (rt.project.mode === "git") {
        const { afterWrites } = await import("@sati/sync");
        const dir = join(rt.location.root, CONFIG_DIR);
        const report = (err: unknown) => printError(err, false);
        const synced = afterWrites(
          rt.ctx.store,
          EXPORT_DEBOUNCE_MS,
          (written) => exportWritten(rt.ctx, dir, written, report),
          report,
        );
        flush = synced.flush;
        ui = {
          ctx: { ...rt.ctx, store: synced.store },
          dataStore: rt.ctx.store,
          onKind,
          templates,
        };
      }
      const app = createUiApp(ui, token, uiDir());
      const server = await listenUi(app, port);
      const url = `http://127.0.0.1:${server.port}/session?token=${token}`;
      process.stdout.write(`${CLI_NAME} ui on ${url}\n`);
      if (args.open !== false) openBrowser(url);
      let stopping = false;
      const stop = () => {
        // A second Ctrl-C would close an already closed server and reject.
        if (stopping) return;
        stopping = true;
        void server
          .close()
          .then(flush)
          .finally(() => closeRuntime())
          // A failed flush or close must end with a message, not an unhandled rejection.
          .catch((err: unknown) => {
            process.exitCode = printError(err, false);
          });
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } catch (err) {
      process.exitCode = printError(err, false);
      await closeRuntime();
    }
  },
});
