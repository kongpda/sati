import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLI_NAME } from "@sati/core";
import { listenStore } from "@sati/store-sqlite";
import { defineCommand } from "citty";
import { closeRuntime, openRuntime } from "../runtime.js";

export default defineCommand({
  meta: {
    name: "serve",
    description: "Own the database so other processes can use it over a local socket",
  },
  run: async () => {
    process.env.SATI_DAEMON_OWNER = "1";
    const rt = await openRuntime();
    const socketPath = join(dirname(rt.location.path), "sati.sock");
    if (existsSync(socketPath)) unlinkSync(socketPath);
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
