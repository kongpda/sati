import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bin, type Result, sati, tempRepo } from "./helpers.js";

// PLAN Phase 3: "4 agents in 4 worktrees, random claims, locks and merges for 1,000 steps with
// zero duplicate claims and zero lost records". `pnpm test:e2e` sets the step count and seed;
// the normal suite runs a short scenario so a regression shows up before CI's long runs.
const STEPS = Number(process.env.SATI_E2E_STEPS ?? 40);
const SEED = Number(process.env.SATI_E2E_SEED ?? 1);
const AGENTS = 4;
const PATHS = ["src/api", "src/ui", "src/db", "docs", "test", "scripts"];

/** mulberry32: a small seeded generator, so a failing seed can be replayed exactly. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function runAsync(cwd: string, args: string[], actor: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args, "--json"], {
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

type Op =
  | { kind: "create"; title: string }
  | { kind: "claim"; taskId: string }
  | { kind: "complete"; taskId: string }
  | { kind: "lock"; path: string }
  | { kind: "release"; lockId: string }
  | { kind: "edit"; body: string };

interface TaskModel {
  status: "todo" | "claimed" | "done";
  holder?: number;
}

describe("e2e: four agents in four worktrees", () => {
  it(
    `${STEPS} random claims, locks, edits and merges lose nothing and never double-claim (seed ${SEED})`,
    async () => {
      const random = rng(SEED);
      const pick = <T>(items: T[]): T | undefined => items[Math.floor(random() * items.length)];
      const dir = await tempRepo();
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=Tester", "-c", "user.email=t@example.test", ...args],
          {
            cwd,
            encoding: "utf8",
            env: { ...process.env, SATI_ACTOR: "merger", CLAUDECODE: "", AI_AGENT: "" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      const json = <T>(r: Result): T => JSON.parse(r.stdout) as T;
      try {
        // A real init: hooks, merge driver and .gitattributes, as a user would have them.
        expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
        const shared = json<{ id: string }>(sati(dir, "task", "create", "Shared", "--json")).id;
        git(dir, "add", "-A");
        git(dir, "commit", "-qm", "init");
        const trees = [dir];
        for (let i = 1; i < AGENTS; i++) {
          trees.push(join(dir, `wt-${i}`));
          git(dir, "worktree", "add", "-q", "-b", `agent-${i}`, join(dir, `wt-${i}`));
        }
        const branch = (i: number) => (i === 0 ? "main" : `agent-${i}`);

        const tasks = new Map<string, TaskModel>([[shared, { status: "todo" }]]);
        const locks = new Map<string, { holder: number; path: string }>();
        let claims = 0;
        let merges = 0;

        const choose = (agent: number, step: number): Op => {
          const mine = [...tasks].filter(([, t]) => t.status === "claimed" && t.holder === agent);
          const myLocks = [...locks].filter(([, l]) => l.holder === agent);
          const r = random();
          if (r < 0.2) return { kind: "create", title: `Task ${step}` };
          if (r < 0.45) {
            // Any unfinished task not ours, so agents race for the same ones.
            const open = [...tasks].filter(([, t]) => t.status !== "done" && t.holder !== agent);
            const id = pick(open)?.[0];
            if (id) return { kind: "claim", taskId: id };
          }
          if (r < 0.6) {
            const id = pick(mine)?.[0];
            if (id) return { kind: "complete", taskId: id };
          }
          if (r < 0.8) {
            const held = new Set(myLocks.map(([, l]) => l.path));
            const path = pick(PATHS.filter((p) => !held.has(p)));
            if (path) return { kind: "lock", path };
          }
          if (r < 0.9) {
            const id = pick(myLocks)?.[0];
            if (id) return { kind: "release", lockId: id };
          }
          return { kind: "edit", body: `agent ${agent} step ${step}` };
        };

        const argsOf = (op: Op): string[] => {
          switch (op.kind) {
            case "create":
              return ["task", "create", op.title];
            case "claim":
              return ["task", "claim", op.taskId];
            case "complete":
              return ["task", "complete", op.taskId, "--summary", "done", "--files", "src/x.ts"];
            case "lock":
              return ["lock", "acquire", op.path];
            case "release":
              return ["lock", "release", op.lockId];
            case "edit":
              return ["task", "update", shared, "--body", op.body];
          }
        };

        for (let step = 0; step < STEPS; step += AGENTS) {
          // All four agents act at once, each in its own worktree and process.
          const ops = trees.map((_, agent) => choose(agent, step + agent));
          const results = await Promise.all(
            ops.map((op, agent) => runAsync(trees[agent] ?? dir, argsOf(op), `agent-${agent}`)),
          );
          const where = `seed ${SEED}, step ${step}`;
          const what = (agent: number) =>
            `${where}, agent ${agent} ${ops[agent]?.kind}: ${results[agent]?.stdout}${results[agent]?.stderr}`;
          for (const [agent, r] of results.entries()) {
            expect(r.stderr, what(agent)).not.toMatch(/SQLITE_BUSY|database is locked/);
          }
          // The agents ran at once, so check against the state at the start of the round, and
          // allow either outcome only where two ops of this round raced on the same record.
          const sharedAtStart: TaskModel | undefined = structuredClone(tasks.get(shared));
          const heldAtStart = new Map([...locks.values()].map((l) => [l.path, l.holder]));
          const freed = new Set<string>();
          for (const [agent, op] of ops.entries()) {
            const code = results[agent]?.code;
            if (op.kind === "create" || op.kind === "complete" || op.kind === "release") {
              expect(code, what(agent)).toBe(0);
            }
            if (op.kind === "create") {
              tasks.set(json<{ id: string }>(results[agent] as Result).id, { status: "todo" });
            }
            if (op.kind === "complete") tasks.set(op.taskId, { status: "done" });
            if (op.kind === "release") {
              freed.add(locks.get(op.lockId)?.path ?? "");
              locks.delete(op.lockId);
            }
          }
          const claimWinners = new Map<string, number>();
          const lockWinners = new Map<string, number>();
          for (const [agent, op] of ops.entries()) {
            const r = results[agent] as Result;
            if (op.kind === "claim" && r.code === 0) {
              // Only an unclaimed task can be won, and only by one agent per race.
              expect(tasks.get(op.taskId)?.status, what(agent)).toBe("todo");
              expect(claimWinners.get(op.taskId), `${what(agent)}: claimed twice`).toBeUndefined();
              claimWinners.set(op.taskId, agent);
              tasks.set(op.taskId, { status: "claimed", holder: agent });
              claims++;
            }
            if (op.kind === "lock" && r.code === 0) {
              const holder = heldAtStart.get(op.path);
              expect(holder === undefined || freed.has(op.path), what(agent)).toBe(true);
              expect(lockWinners.get(op.path), `${what(agent)}: locked twice`).toBeUndefined();
              lockWinners.set(op.path, agent);
              locks.set(json<{ lock: { id: string } }>(r).lock.id, {
                holder: agent,
                path: op.path,
              });
            }
          }
          for (const [agent, op] of ops.entries()) {
            const code = results[agent]?.code;
            if (op.kind === "claim" && code !== 0) {
              // CONFLICT when someone holds it; INVALID_TRANSITION when it finished meanwhile.
              expect([4, 8], what(agent)).toContain(code);
              expect(tasks.get(op.taskId)?.status, what(agent)).not.toBe("todo");
            }
            if (op.kind === "lock" && code !== 0) {
              expect(code, what(agent)).toBe(4);
              const other = heldAtStart.has(op.path) || lockWinners.has(op.path);
              expect(other, `${what(agent)}: refused a free path`).toBe(true);
            }
            if (op.kind === "edit") {
              // A claimed task takes writes only from its holder (fencing token).
              const blocked = (t?: TaskModel) => t?.status === "claimed" && t.holder !== agent;
              const allowed = [blocked(sharedAtStart) ? 4 : 0, blocked(tasks.get(shared)) ? 4 : 0];
              expect(allowed, what(agent)).toContain(code);
            }
          }

          // Between rounds, one agent may commit and merge: main pulls a branch, or a branch
          // pulls main. git serializes ref updates, so these run one at a time.
          if (random() < 0.3) {
            const agent = Math.floor(random() * AGENTS);
            const cwd = trees[agent] ?? dir;
            git(cwd, "add", "-A", ".sati");
            git(cwd, "commit", "-qm", `agent ${agent} at ${step}`, "--allow-empty");
            const from = agent === 0 ? branch(1 + Math.floor(random() * (AGENTS - 1))) : "main";
            git(cwd, "merge", "--no-edit", "-q", from);
            merges++;
          }
        }

        // Land everything on main.
        for (let agent = 1; agent < AGENTS; agent++) {
          const cwd = trees[agent] ?? dir;
          git(cwd, "add", "-A", ".sati");
          git(cwd, "commit", "-qm", `agent ${agent} final`, "--allow-empty");
        }
        git(dir, "add", "-A", ".sati");
        git(dir, "commit", "-qm", "main final", "--allow-empty");
        for (let agent = 1; agent < AGENTS; agent++)
          git(dir, "merge", "--no-edit", "-q", branch(agent));

        // Zero lost records: every task created anywhere is in main's history.
        const committed = git(dir, "ls-tree", "-r", "--name-only", "HEAD", ".sati/tasks")
          .trim()
          .split("\n");
        expect(committed.sort()).toEqual(
          [...tasks.keys()].map((id) => `.sati/tasks/${id}.json`).sort(),
        );

        // The database agrees with what every agent was told.
        expect(sati(dir, "sync", "export").code).toBe(0);
        const actors = new Map<string, number>();
        for (const name of readdirSync(join(dir, ".sati/tasks"))) {
          const t = JSON.parse(readFileSync(join(dir, ".sati/tasks", name), "utf8")) as {
            id: string;
            status: string;
            claim: { actorId: string } | null;
          };
          const model = tasks.get(t.id);
          expect(model, `unknown task ${t.id}`).toBeDefined();
          if (model?.status === "done") expect(t.status).toBe("done");
          if (model?.status === "todo") expect(t.claim).toBeNull();
          if (model?.status === "claimed" && model.holder !== undefined) {
            const actor = t.claim?.actorId;
            expect(actor).toBeDefined();
            // One actor id per agent: a claim recorded for anyone else would be a duplicate.
            const seen = actors.get(actor ?? "");
            if (seen === undefined) actors.set(actor ?? "", model.holder);
            else expect(seen).toBe(model.holder);
          }
        }
        expect(claims + merges).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    Math.max(60_000, STEPS * 1_000),
  );
});
