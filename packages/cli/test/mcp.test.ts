import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { bin, brain, brainJson, run, tempRepo } from "./helpers.js";

// Agents launch `brain mcp` from their MCP config; this checks the built binary end to end.
describe("brain mcp", () => {
  it("serves tools over stdio that write to the same DB as the CLI", async () => {
    const dir = await tempRepo({ init: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp"],
      cwd: dir,
      env: { ...process.env, BRAIN_ACTOR: "agent-a", CLAUDECODE: "" } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("task_claim");
    const res = await client.callTool({ name: "task_create", arguments: { title: "From MCP" } });
    expect(res.isError).toBeFalsy();
    await client.close();

    const listed = brainJson<{ title: string }[]>(dir, "task", "list");
    expect(listed.data.map((t) => t.title)).toEqual(["From MCP"]);
  });

  it("exits with NOT_INITIALIZED on stderr, keeping stdout clean for the protocol", async () => {
    const dir = await tempRepo();
    const r = run(dir, ["mcp"]);
    expect(r.code).toBe(6);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("brain init");
  });

  it("exits cleanly when the client closes stdin", async () => {
    const dir = await tempRepo({ init: true });
    expect(brain(dir, "mcp").code).toBe(0);
  });
});
