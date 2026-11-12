import { once } from "node:events";
import { unlinkSync } from "node:fs";
import { connect, type Server } from "node:net";
import { CLI_NAME, SatiError, type StorageAdapter } from "@sati/core";
import { listenStore, socketPath as socketPathFor } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { closeRuntime, openRuntime } from "../runtime/location.js";
import { printError } from "../runtime/output.js";

/** True when something accepts connections on the socket; a stale file refuses or is gone. */
function isLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      // Only ECONNREFUSED / ENOENT prove the socket is dead; anything else is not ours to remove.
      resolve(err.code !== "ECONNREFUSED" && err.code !== "ENOENT");
    });
  });
}

const running = () =>
  new SatiError("CONFLICT", `${CLI_NAME} serve is already running for this project.`, {
    hint: `Stop the other \`${CLI_NAME} serve\` first, or just use it: other commands already connect to it.`,
  });

/**
 * Listen first and probe only when the address is taken. Checking before listening let two
 * starts race: the loser crashed with an unhandled EADDRINUSE instead of exiting 4 (review 5.6).
 * A stale Unix socket file is removed once; a Windows pipe goes away with its process.
 */
async function listen(store: StorageAdapter, socketPath: string): Promise<Server> {
  for (let attempt = 0; ; attempt++) {
    const server = listenStore(store, socketPath);
    try {
      await once(server, "listening");
      return server;
    } catch (err) {
      server.close();
      // macOS reports a taken socket path as EEXIST as well.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EEXIST") throw err;
      if (process.platform === "win32" || attempt > 0 || (await isLive(socketPath))) {
        throw running();
      }
      unlinkSync(socketPath);
    }
  }
}

export default defineCommand({
  meta: {
    name: "serve",
    description:
      "Own the database so other processes can use it over a local socket. Exit 4 if one is already running",
  },
  run: async () => {
    process.env.SATI_DAEMON_OWNER = "1";
    const rt = await openRuntime();
    const socketPath = socketPathFor(rt.location.path);
    const server = await listen(rt.ctx.store, socketPath);
    process.stdout.write(`${CLI_NAME} serve ${socketPath}\n`);
    const stop = () => {
      server.close();
      // A failed close must still end the process with a message, not an unhandled rejection.
      closeRuntime().catch((err: unknown) => {
        process.exitCode = printError(err, false);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },
});
