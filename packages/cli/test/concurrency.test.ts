import { execFileSync, spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bin, type Result, satiJson, tempRepo } from "./helpers.js";

interface Rec {
  id: string;
  claim: { actorId: string } | null;
}

const stress = process.env.SATI_WORKTREE_STRESS === "1";
const rounds = stress ? 125 : 1;
const seed = Number(process.env.SATI_WORKTREE_SEED ?? 42);

function seededOrder(seed: number): number[] {
  const slots = [0, 1, 2, 3];
  for (let index = slots.length - 1; index > 0; index--) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const other = seed % (index + 1);
    const first = slots[index];
    const second = slots[other];
    if (first === undefined || second === undefined) throw new Error("Invalid shuffle index");
    slots[index] = second;
    slots[other] = first;
  }
  return slots;
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
  it(
    "shares claims and exclusive locks across four Git worktrees",
    async () => {
      const dir = await tempRepo({ init: true });
      const gitAt = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=Tester", "-c", "user.email=test@example.test", ...args],
          {
            cwd,
            encoding: "utf8",
          },
        );
      const git = (...args: string[]) => gitAt(dir, ...args);
      try {
        const shared = satiJson<Rec>(dir, "task", "create", "Shared record", "--body", "base");
        expect(shared.code).toBe(0);
        git("config", "merge.sati.driver", `"${process.execPath}" "${bin}" merge-driver %O %A %B`);
        writeFileSync(join(dir, ".gitattributes"), ".sati/**/*.json merge=sati\n");
        git("add", ".gitattributes", ".sati/tasks");
        git("commit", "-m", "Initial commit");
        const worktrees = [dir];
        for (let index = 1; index < 4; index++) {
          const path = join(dir, `worktree-${index}`);
          git("worktree", "add", "-b", `worker-${index}`, path);
          worktrees.push(path);
        }
        const race = (args: string[], seed: number) =>
          Promise.all(
            seededOrder(seed).map((index) => {
              const path = worktrees[index];
              if (!path) throw new Error(`Missing worktree ${index}`);
              return runAsync(path, args, `worker-${index}`);
            }),
          );
        const expected = [shared.data.id];
        for (let round = 0; round < rounds; round++) {
          const created = satiJson<Rec>(dir, "task", "create", `Cross-worktree claim ${round}`);
          expect(created.code).toBe(0);
          expected.push(created.data.id);

          const [claims, locks] = await Promise.all([
            race(["task", "claim", created.data.id, "--json"], seed + round),
            race(["lock", "acquire", `src/round-${round}`, "--json"], seed + round + 1),
          ]);
          for (const results of [claims, locks]) {
            expect(results.map((result) => result.code).sort(), `round ${round}`).toEqual([
              0, 4, 4, 4,
            ]);
            for (const result of results) {
              expect(result.stderr).not.toMatch(/SQLITE_BUSY|database is locked/);
            }
          }
        }

        for (const [index, path] of worktrees.entries()) {
          const edited = satiJson(
            path,
            "task",
            "update",
            shared.data.id,
            "--body",
            `worker ${index}`,
          );
          expect(edited.code).toBe(0);
          const created = satiJson<Rec>(path, "task", "create", `Worktree ${index} record`);
          expect(created.code).toBe(0);
          expected.push(created.data.id);
          gitAt(path, "add", ".sati/tasks");
          gitAt(path, "commit", "-m", `Save worktree ${index} records`);
        }
        for (const index of seededOrder(seed + 2).filter((index) => index !== 0)) {
          git("merge", "--no-edit", `worker-${index}`);
        }
        const files = git("ls-tree", "-r", "--name-only", "HEAD", ".sati/tasks").trim().split("\n");
        expect(files.sort()).toEqual(expected.map((id) => `.sati/tasks/${id}.json`).sort());
        const merged = JSON.parse(git("show", `HEAD:.sati/tasks/${shared.data.id}.json`));
        expect(merged).toMatchObject({ id: shared.data.id, needsReview: true });
        for (let index = 0; index < worktrees.length; index++) {
          expect(merged.body).toContain(`worker ${index}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    stress ? 300_000 : 60_000,
  );

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
