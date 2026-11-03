/**
 * Benchmarks for the Phase 1 CLI budgets (PLAN "Performance budgets"). Run with `pnpm bench`
 * after a build. Exits 1 if any budget is missed.
 *
 * Budgets checked here: CLI cold start, CLI read p95, full-text search on 50,000 records and
 * `task_claim` under 10 concurrent agents. The other budgets belong to later phases.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimTask,
  createIdFactory,
  createNote,
  createTask,
  ensureActor,
  type Note,
  type ServiceContext,
  search,
  systemClock,
  type Task,
} from "@brain/core";
import { clearLocateCache, locateDb, SqliteStore } from "@brain/store-sqlite";

const bin = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
const RECORDS = 50_000;
const RUNS = 30;
const AGENTS = 10;
const CLAIMS_PER_AGENT = 50;

const WORDS = (
  "auth token session cache index query schema migration router handler parser render " +
  "layout button form input upload download export import sync merge conflict lock lease " +
  "agent brief task feature note decision search ranking snippet worker queue retry " +
  "timeout logger metric trace config secret header cookie payload webhook billing invoice"
).split(" ");

/** Deterministic pseudo-random words, so every run searches the same corpus. */
function words(seed: number, count: number): string {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    out.push(WORDS[x % WORDS.length] ?? "agent");
  }
  return out.join(" ");
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function time(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function cli(cwd: string, args: string[]): void {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, BRAIN_ACTOR: "bench" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`brain ${args.join(" ")} failed: ${r.stderr}`);
}

/** Inserts `RECORDS` tasks and notes in one transaction, cloned from service-made templates. */
async function seed(dir: string): Promise<ServiceContext> {
  clearLocateCache();
  const store = await SqliteStore.open(locateDb(dir).path);
  const project = await store.read((r) => r.getProject());
  if (!project) throw new Error("seed: no project");
  const ids = createIdFactory();
  const deps = { store, clock: systemClock, ids, branch: null };
  const actor = await ensureActor(
    { ...deps, projectId: project.id },
    { name: "bench", kind: "human" },
  );
  const ctx: ServiceContext = { ...deps, projectId: project.id, actorId: actor.id };
  const task: Task = await createTask(ctx, { title: "template task" });
  const note: Note = await createNote(ctx, { title: "template note" });
  await store.write(async (w) => {
    for (let i = 0; i < RECORDS / 2; i++) {
      await w.insert("task", {
        ...task,
        id: ids("task"),
        title: words(i, 5),
        body: words(i + 7, 30),
      });
      await w.insert("note", {
        ...note,
        id: ids("note"),
        title: words(i + 3, 5),
        body: words(i + 11, 40),
      });
    }
  });
  return ctx;
}

/**
 * One simulated agent: a long-lived process (like the MCP server) with its own DB connection
 * and actor, claiming its tasks. Waits until `startAt` so all agents contend at once, then
 * prints the claim latencies as JSON.
 */
async function claimWorker(dir: string, name: string, startAt: number, ids: string[]) {
  const store = await SqliteStore.open(locateDb(dir).path);
  const project = await store.read((r) => r.getProject());
  if (!project) throw new Error("worker: no project");
  const deps = { store, clock: systemClock, ids: createIdFactory(), branch: null };
  const actor = await ensureActor({ ...deps, projectId: project.id }, { name, kind: "agent" });
  const ctx: ServiceContext = { ...deps, projectId: project.id, actorId: actor.id };
  while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 5));
  const samples: number[] = [];
  for (const id of ids) {
    const start = performance.now();
    await claimTask(ctx, id);
    samples.push(performance.now() - start);
  }
  await store.close();
  process.stdout.write(JSON.stringify(samples));
}

/** Runs `AGENTS` worker processes at once and returns every claim latency. */
async function concurrentClaims(dir: string, ctx: ServiceContext): Promise<number[]> {
  const ids: string[] = [];
  for (let i = 0; i < AGENTS * CLAIMS_PER_AGENT; i++) {
    ids.push((await createTask(ctx, { title: `claim target ${i}` })).id);
  }
  const startAt = Date.now() + 2_000;
  const self = fileURLToPath(import.meta.url);
  const runs = Array.from({ length: AGENTS }, (_, a) => {
    const mine = ids.slice(a * CLAIMS_PER_AGENT, (a + 1) * CLAIMS_PER_AGENT);
    const args = [self, "--claim-worker", dir, `agent-${a}`, String(startAt), ...mine];
    return new Promise<number[]>((resolve, reject) => {
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.on("close", (code) =>
        code === 0 ? resolve(JSON.parse(out) as number[]) : reject(new Error(`worker ${a} failed`)),
      );
    });
  });
  return (await Promise.all(runs)).flat();
}

interface Result {
  measure: string;
  value: number;
  budget: number;
}

async function main(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "brain-bench-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  cli(dir, ["init", "--yes"]);
  const seedStart = performance.now();
  const ctx = await seed(dir);
  console.log(`Seeded ${RECORDS} records in ${Math.round(performance.now() - seedStart)} ms.`);

  // Warm the OS file cache once, as an agent's repeated calls would.
  cli(dir, ["--version"]);
  cli(dir, ["task", "list"]);

  const coldStart = Array.from({ length: RUNS }, () => time(() => cli(dir, ["--version"])));
  const reads = [
    ["task", "list", "--json"],
    ["task", "list", "--ready", "--json"],
    ["search", "auth token", "--json"],
  ].flatMap((args) => Array.from({ length: RUNS }, () => time(() => cli(dir, args))));

  const queries = ["auth", "token session", "merge conflict", "webhook billing", "zzz-none"];
  const fts: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    for (const query of queries) {
      const start = performance.now();
      await search(ctx, { query, limit: 20 });
      fts.push(performance.now() - start);
    }
  }
  const claims = await concurrentClaims(dir, ctx);
  await ctx.store.close();

  const results: Result[] = [
    {
      measure: "CLI cold start (brain --version), p95",
      value: percentile(coldStart, 95),
      budget: 80,
    },
    { measure: "CLI read command, p95", value: percentile(reads, 95), budget: 150 },
    {
      measure: `Full-text search on ${RECORDS} records, p95`,
      value: percentile(fts, 95),
      budget: 50,
    },
    {
      measure: `task_claim under ${AGENTS} concurrent agents, p95`,
      value: percentile(claims, 95),
      budget: 50,
    },
  ];
  let failed = false;
  for (const r of results) {
    const ok = r.value < r.budget;
    failed ||= !ok;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${r.measure.padEnd(48)} ${r.value.toFixed(1).padStart(7)} ms  (budget ${r.budget} ms)`,
    );
  }
  if (failed) process.exitCode = 1;
}

const [mode, dir, name, startAt, ...ids] = process.argv.slice(2);
if (mode === "--claim-worker" && dir && name && startAt) {
  await claimWorker(dir, name, Number(startAt), ids);
} else {
  await main();
}
