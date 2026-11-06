import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAME, SatiError } from "@sati/core";
import { defineCommand } from "citty";
import { closeRuntime, openRuntime, printError } from "../runtime.js";
import { createUiApp, listenUi, sessionToken } from "../ui/server.js";

function uiDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../ui/dist"),
    join(here, "../../ui/dist"),
    join(process.cwd(), "packages/ui/dist"),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, "index.html")));
  if (!found) {
    throw new SatiError("USAGE", "The web UI has not been built.", {
      hint: "From the repo, run `pnpm --filter @sati/ui build`.",
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
      const rt = await openRuntime();
      const token = sessionToken();
      const app = createUiApp(rt, token, uiDir());
      const port = args.port ? Number(args.port) : 0;
      if (args.port && !Number.isInteger(port)) {
        throw new SatiError("USAGE", "Port must be an integer.");
      }
      const server = await listenUi(app, port);
      const url = `http://127.0.0.1:${server.port}/session?token=${token}`;
      process.stdout.write(`${CLI_NAME} ui on ${url}\n`);
      if (args.open !== false) openBrowser(url);
      const stop = () => {
        void server.close().finally(() => closeRuntime());
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    } catch (err) {
      process.exitCode = printError(err, false);
      await closeRuntime();
    }
  },
});
