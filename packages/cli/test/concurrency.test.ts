import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bin, type Result, satiJson, tempRepo } from "./helpers.js";

interface Rec {
  id: string;
  claim: { actorId: string } | null;
}

/** Like `run`, but async, so many processes can race at once. */
function runAsync(cwd: string, args: string[], actor: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, SATI_ACTOR: actor, CLAUDECODE: "", AI_AGENT: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// PLAN: "Duplicate work (two agents, same task): zero". Separate processes share one SQLite
// file, so only the database lock can make the claim atomic; in-process tests cannot show it.
describe("concurrent claims", () => {
  it("20 processes claiming one task: exactly one wins, the rest get CONFLICT, none see BUSY", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Rec>(dir, "task", "create", "Contested").data;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runAsync(dir, ["task", "claim", task.id, "--json"], `agent-${i}`),
      ),
    );

    const winners = results.filter((r) => r.code === 0);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.code === 4)).toHaveLength(19);
    for (const r of results) expect(r.stderr).not.toMatch(/SQLITE_BUSY|database is locked/);

    const winner = JSON.parse(winners[0]?.stdout ?? "{}") as Rec;
    const stored = satiJson<Rec>(dir, "task", "show", task.id).data;
    expect(stored.claim?.actorId).toBe(winner.claim?.actorId);
  }, 60_000);

  // Same race for locks: the overlap check and the insert must be one transaction.
  it("10 processes locking overlapping paths: exactly one gets the lock", async () => {
    const dir = await tempRepo({ init: true });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        runAsync(dir, ["lock", "acquire", i % 2 ? "src/**" : "src", "--json"], `agent-${i}`),
      ),
    );
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === 4)).toHaveLength(9);
    for (const r of results) expect(r.stderr).not.toMatch(/SQLITE_BUSY|database is locked/);
    expect(satiJson<unknown[]>(dir, "lock", "list").data).toHaveLength(1);
  }, 60_000);
});
