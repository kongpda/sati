import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProjectKind, ServiceContext, TemplateFile } from "@sati/core";
import { createServer } from "./server.js";

export { createServer } from "./server.js";

/** Serves MCP over stdin/stdout until the client disconnects. */
export async function serveStdio(
  ctx: ServiceContext,
  version?: string,
  kind?: ProjectKind,
  root?: string,
  templates?: () => TemplateFile[],
  /** Called once with the client's name from `clientInfo`; it may set `ctx.actorId`. */
  onClient?: (ctx: ServiceContext, name: string) => Promise<void>,
): Promise<void> {
  const server = createServer(ctx, version, kind, root, templates);
  server.server.oninitialized = () => {
    const name = server.server.getClientVersion()?.name;
    if (name && onClient) {
      onClient(ctx, name).catch((err: unknown) => {
        process.stderr.write(`warning: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  };
  let stop: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    stop = resolve;
    server.server.onclose = resolve;
    // The stdio transport does not notice the client going away; stdin ending is that signal.
    process.stdin.once("end", resolve);
    // SIGTERM/SIGINT end the serve loop, so the caller's cleanup (the debounced `.sati/` export
    // flush) runs instead of the process dying with writes not yet exported.
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
  await server.connect(new StdioServerTransport());
  await closed;
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await server.close();
}
