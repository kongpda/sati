import type { ServiceContext } from "@brain/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

export { createServer } from "./server.js";
export { WORKFLOW } from "./workflow.js";

/** Serves MCP over stdin/stdout until the client disconnects. */
export async function serveStdio(ctx: ServiceContext): Promise<void> {
  const server = createServer(ctx);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    // The stdio transport does not notice the client going away; stdin ending is that signal.
    process.stdin.once("end", resolve);
  });
  await server.connect(new StdioServerTransport());
  await closed;
  await server.close();
}
