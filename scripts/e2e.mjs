#!/usr/bin/env node
// Runs the end-to-end scenarios: the agent loop once, then the four-worktree scenario
// (PLAN Phase 3 gate) once per seed. Needs a built CLI (`pnpm build`).
//
//   pnpm test:e2e                       one 1,000-step run, seed 1
//   pnpm test:e2e --repeat 100          100 runs, seeds 1..100
//   pnpm test:e2e --repeat 10 --seed 51 seeds 51..60
//   pnpm test:e2e --steps 200           shorter runs
//
// A failure prints its seed; rerun it with `--seed <n>`.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    repeat: { type: "string", default: "1" },
    seed: { type: "string", default: "1" },
    steps: { type: "string", default: "1000" },
  },
});
const count = (name) => {
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${name} must be a positive integer, got ${values[name]}`);
    process.exit(2);
  }
  return n;
};
const repeat = count("repeat");
const first = count("seed");
const steps = count("steps");

const vitest = (pkg, file, env = {}) =>
  spawnSync("pnpm", ["--filter", pkg, "exec", "vitest", "run", file], {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  }).status;

if (vitest("@sati/core", "test/loop.test.ts") !== 0) process.exit(1);
for (let seed = first; seed < first + repeat; seed++) {
  console.log(`\ne2e: seed ${seed} (${seed - first + 1}/${repeat}), ${steps} steps`);
  const env = { SATI_E2E_SEED: String(seed), SATI_E2E_STEPS: String(steps) };
  if (vitest("@kongpda/sati", "test/e2e.test.ts", env) !== 0) {
    console.error(`e2e failed at seed ${seed}; rerun with: pnpm test:e2e --seed ${seed}`);
    process.exit(1);
  }
}
console.log(`\ne2e: ${repeat} run(s) passed`);
