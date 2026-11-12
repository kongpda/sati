import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

// Agents launch `sati mcp` from their MCP config; this checks the built binary end to end.
describe("sati mcp", () => {
  it("serves tools over stdio that write to the same DB as the CLI", async () => {
    const dir = await tempRepo({ init: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin, "mcp"],
      cwd: dir,
      env: { ...process.env, SATI_ACTOR: "agent-a", CLAUDECODE: "" } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("task_claim");
    const res = await client.callTool({ name: "task_create", arguments: { title: "From MCP" } });
    expect(res.isError).toBeFalsy();
    await client.close();

    const listed = satiJson<{ title: string }[]>(dir, "task", "list");
    expect(listed.data.map((t) => t.title)).toEqual(["From MCP"]);
  });

  // Review 6.10: the Desktop entry is about the MCP server, so `mcp` prints it. `init --desktop`
  // stays for old instructions but help no longer lists it.
  it("mcp --desktop prints the config entry and does not start the server", async () => {
    const dir = await tempRepo({ init: true });
    // Closed stdin would end a running server quietly; a printed entry proves it never started.
    const printed = satiJson<{
      desktop: { mcpServers: Record<string, { command: string; args: string[] }> };
    }>(dir, "mcp", "--desktop");
    const [entry] = Object.values(printed.data.desktop.mcpServers);
    expect(entry?.args.slice(1)).toEqual(["mcp", "--project", dir]);
    const text = sati(dir, "mcp", "--desktop");
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("claude_desktop_config.json");
    expect(run(dir, ["init", "--desktop"]).stdout).toContain("claude_desktop_config.json");
    expect(sati(dir, "init", "--help").stdout).not.toContain("--desktop");
    expect(sati(dir, "mcp", "--help").stdout).toContain("--desktop");
    // Before init there is no server to start, so no entry is printed.
    expect(sati(await tempRepo(), "mcp", "--desktop").code).not.toBe(0);
  });

  it("exits with NOT_INITIALIZED on stderr, keeping stdout clean for the protocol", async () => {
    const dir = await tempRepo();
    const r = run(dir, ["mcp"]);
    expect(r.code).toBe(6);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("sati init");
  });

  it("exits cleanly when the client closes stdin", async () => {
    const dir = await tempRepo({ init: true });
    expect(sati(dir, "mcp").code).toBe(0);
  });
});
