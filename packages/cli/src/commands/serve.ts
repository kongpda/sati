import { existsSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { CLI_NAME, SatiError } from "@sati/core";
import { listenStore, socketPath as socketPathFor } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { closeRuntime, openRuntime } from "../runtime.js";

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
    // A stale Unix socket file blocks listen(). A Windows pipe goes away with its process.
    if (process.platform !== "win32" && existsSync(socketPath)) {
      if (await isLive(socketPath)) {
        throw new SatiError("CONFLICT", `${CLI_NAME} serve is already running for this project.`, {
          hint: `Stop the other \`${CLI_NAME} serve\` first, or just use it: other commands already connect to it.`,
        });
      }
      unlinkSync(socketPath);
    }
    const server = listenStore(rt.ctx.store, socketPath);
    process.stdout.write(`${CLI_NAME} serve ${socketPath}\n`);
    const stop = () => {
      server.close();
      void closeRuntime();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  },
});
