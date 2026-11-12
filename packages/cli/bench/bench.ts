/**
 * Benchmarks for the Phase 1 CLI budgets (PLAN "Performance budgets"). Run with `pnpm bench`
 * after a build. Exits 1 if any budget is missed.
 *
 * `BENCH_FACTOR=3` multiplies every time budget by 3. CI sets it: a shared runner is slower and
 * less even than the laptop the budgets are written for, and the run there is to catch a change
 * that makes something several times slower, not to prove the budgets.
 *
 * Budgets checked here: CLI cold start, CLI read p95, full-text search and `recall` on 50,000
 * records and cards, `task_claim` under 10 concurrent agents, the home screen of a bare `sati`,
 * and the idle cost of `sati activity --follow`. The other budgets belong to later phases.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ContextEntry,
  claimTask,
  createIdFactory,
  createNote,
  createTask,
  ensureActor,
  type Note,
  putContext,
  recall,
  type ServiceContext,
  search,
  systemClock,
  type Task,
} from "@sati/core";
import { clearLocateCache, locateDb, SqliteStore } from "@sati/store-sqlite";

const bin = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
const RECORDS = 50_000;
/** Cards among the seeded records (Phase 8 `recall` budget). */
const CARDS = 2_000;
const RUNS = 30;
const AGENTS = 10;
const CLAIMS_PER_AGENT = 50;
const PTY = fileURLToPath(new URL("../test/support/pty-run.py", import.meta.url));
/** How long `activity --follow` is left idle while its CPU time is read. */
const IDLE_MS = 5_000;
/**
 * Open tasks in the first project the home screen is timed on, with as many new notes. The inbox
 * it shows reads open tasks and the notes of the last two weeks, so its cost grows with the open
 * work; 5,000 open tasks is far more than a real project has.
 */
const HOME_TASKS = 5_000;
/** How much slower than the budgets this machine may be (see the top of the file). */
const FACTOR = Number(process.env.BENCH_FACTOR ?? "1");
if (!(FACTOR >= 1)) throw new Error("BENCH_FACTOR must be a number, 1 or more.");

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
    env: { ...process.env, SATI_ACTOR: "bench" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`sati ${args.join(" ")} failed: ${r.stderr}`);
}

/** A person's environment: no agent variable, so questions may be asked. */
const person = (): NodeJS.ProcessEnv => ({
  ...process.env,
  SATI_ACTOR: "bench",
  CLAUDECODE: "",
  AI_AGENT: "",
  SATI_NO_INPUT: "",
});

/**
 * Milliseconds from starting a bare `sati` in a pseudo-terminal until its menu is drawn and
 * Ctrl-C has closed it. This is more than the time to draw: it includes Python and the exit.
 * Undefined where there is no Python with `pty` (Windows).
 */
function homeDrawn(cwd: string): number | undefined {
  const start = performance.now();
  const r = spawnSync("python3", [PTY, "What next", "\\x03", process.execPath, bin], {
    cwd,
    env: person(),
    encoding: "utf8",
  });
  if (r.error !== undefined || !r.stdout.includes("What next")) return undefined;
  return performance.now() - start;
}

/** CPU seconds a process has used, from `ps` ("0:00.09"). */
function cpuSeconds(pid: number): number {
  const text = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim();
  return text
    .split(":")
    .map(Number)
    .reduce((sum, part) => sum * 60 + part, 0);
}

/**
 * Percent of one core `sati activity --follow` uses while nothing is written. Undefined on
 * Windows, which has no `ps`.
 */
async function followIdle(cwd: string): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  const child = spawn(process.execPath, [bin, "activity", "--follow"], {
    cwd,
    env: person(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("close", () => reject(new Error("activity --follow stopped early")));
    });
    if (child.pid === undefined) return undefined;
    const before = cpuSeconds(child.pid);
    await new Promise((resolve) => setTimeout(resolve, IDLE_MS));
    return ((cpuSeconds(child.pid) - before) / (IDLE_MS / 1000)) * 100;
  } finally {
    child.kill("SIGINT");
  }
}

/** Inserts `records` tasks, notes and cards in one transaction, cloned from service-made templates. */
async function seed(
  dir: string,
  records = RECORDS,
  cards = CARDS,
  /** An old project: 9 tasks in 10 are done, and every note is two months old. */
  old = false,
): Promise<ServiceContext> {
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
  const card: ContextEntry = await putContext(ctx, { path: "template", summary: "template" });
  const longAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
  await store.write(async (w) => {
    for (let i = 0; i < cards; i++) {
      await w.insert("context", {
        ...card,
        id: ids("context"),
        path: `docs/${words(i + 5, 2).replace(" ", "-")}-${i}.pdf`,
        summary: words(i + 13, 20),
        facts: [words(i + 17, 8), words(i + 19, 8)],
        tags: [words(i + 23, 1)],
      });
    }
    for (let i = 0; i < (records - cards) / 2; i++) {
      await w.insert("task", {
        ...task,
        id: ids("task"),
        title: words(i, 5),
        body: words(i + 7, 30),
        ...(old && i % 10 !== 0 ? { status: "done" as const } : {}),
      });
      await w.insert("note", {
        ...note,
        id: ids("note"),
        title: words(i + 3, 5),
        body: words(i + 11, 40),
        ...(old ? { createdAt: longAgo, updatedAt: longAgo } : {}),
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
  /** Defaults to milliseconds. */
  unit?: string;
}

async function main(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sati-bench-")));
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
  const asked: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    for (const question of ["what is the auth token?", "merge conflict", "webhook billing"]) {
      const start = performance.now();
      await recall(ctx, { question });
      asked.push(performance.now() - start);
    }
  }
  const claims = await concurrentClaims(dir, ctx);
  await ctx.store.close();

  const small = realpathSync(mkdtempSync(join(tmpdir(), "sati-bench-home-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: small });
  cli(small, ["init", "--yes"]);
  await (await seed(small, HOME_TASKS * 2, 0)).store.close();
  homeDrawn(small);
  const home = Array.from({ length: 10 }, () => homeDrawn(small));
  const aged = realpathSync(mkdtempSync(join(tmpdir(), "sati-bench-old-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: aged });
  cli(aged, ["init", "--yes"]);
  await (await seed(aged, RECORDS, CARDS, true)).store.close();
  homeDrawn(aged);
  const homeOld = Array.from({ length: 10 }, () => homeDrawn(aged));
  const idle = await followIdle(dir);

  const results: Result[] = [
    {
      measure: "CLI cold start (sati --version), p95",
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
      measure: `recall on ${RECORDS} records and cards, p95`,
      value: percentile(asked, 95),
      budget: 50,
    },
    {
      measure: `task_claim under ${AGENTS} concurrent agents, p95`,
      value: percentile(claims, 95),
      budget: 50,
    },
  ];
  const drawn = home.filter((ms): ms is number => ms !== undefined);
  if (drawn.length === home.length) {
    results.push({
      measure: `Home screen (bare sati), ${HOME_TASKS} open tasks, p95`,
      value: percentile(drawn, 95),
      budget: 300,
    });
    results.push({
      measure: `Home screen, ${RECORDS} records, 1 task in 10 open, p95`,
      value: percentile(
        homeOld.filter((ms): ms is number => ms !== undefined),
        95,
      ),
      budget: 300,
    });
  } else console.log("SKIP  Home screen: no python3 with pty here.");
  if (idle !== undefined) {
    results.push({
      measure: "activity --follow, idle, share of one core",
      value: idle,
      budget: 1,
      unit: "%",
    });
  } else console.log("SKIP  activity --follow idle cost: no ps here.");
  let failed = false;
  if (FACTOR !== 1) console.log(`Time budgets are multiplied by ${FACTOR} (BENCH_FACTOR).`);
  for (const r of results) {
    // The idle share is a share of a core, not a time: a slow machine does not raise it much.
    const budget = r.unit === undefined ? r.budget * FACTOR : r.budget;
    const ok = r.value < budget;
    failed ||= !ok;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${r.measure.padEnd(52)} ${r.value.toFixed(1).padStart(7)} ${r.unit ?? "ms"}  (budget ${budget} ${r.unit ?? "ms"})`,
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
