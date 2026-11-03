import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { locateDb, SqliteStore } from "@brain/store-sqlite";
import { describe, expect, it } from "vitest";
import { bin, brain, brainJson, tempRepo } from "./helpers.js";

interface Rec {
  id: string;
  title: string;
}

async function projectId(dir: string): Promise<string> {
  const store = await SqliteStore.open(locateDb(dir).path);
  try {
    return (await store.read((r) => r.getProject()))?.id ?? "";
  } finally {
    await store.close();
  }
}

/** Runs git with `brain` on PATH, so the installed hooks can call it. */
function gitWithBrain(dir: string, ...args: string[]): string {
  const shims = join(dir, ".git", "shims");
  if (!existsSync(shims)) {
    mkdirSync(shims);
    writeFileSync(join(shims, "brain"), `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
    chmodSync(join(shims, "brain"), 0o755);
  }
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    env: { ...process.env, PATH: `${shims}:${process.env.PATH}`, BRAIN_ACTOR: "tester" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("brain sync", () => {
  it("exports changed records to .brain/ and imports them into another clone", async () => {
    const a = await tempRepo({ init: true });
    const b = await tempRepo({ init: true });
    const task = brainJson<Rec>(a, "task", "create", "Shared").data;
    expect(brainJson(a, "sync", "export").data).toEqual({
      written: [join("tasks", `${task.id}.json`)],
      unchanged: 0,
    });
    expect(brainJson(a, "sync", "export").data).toEqual({ written: [], unchanged: 1 });

    // Copy the snapshot by hand. Clones of one repo share the project id, so give b's id to the record.
    const file = readFileSync(join(a, ".brain", "tasks", `${task.id}.json`), "utf8");
    const bProject = await projectId(b);
    mkdirSync(join(b, ".brain", "tasks"), { recursive: true });
    writeFileSync(
      join(b, ".brain", "tasks", `${task.id}.json`),
      file.replace(/"projectId": "[^"]+"/, `"projectId": "${bProject}"`),
    );
    expect(brain(b, "sync", "import")).toMatchObject({
      code: 0,
      stdout: "Imported 1 newer, 0 unchanged.\n",
    });
    expect(brainJson<Rec>(b, "task", "show", task.id).data.title).toBe("Shared");
  });

  it("refuses stealth mode, which commits nothing", async () => {
    const dir = await tempRepo();
    brain(dir, "init", "--yes", "--mode", "stealth", "--tools", "");
    const r = brain(dir, "sync", "export");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs git mode");
  });
});

// PLAN: pre-commit exports and stages .brain/; post-merge imports a teammate's records.
describe("git hooks", () => {
  it("a commit carries the snapshot, and a pull brings it into the other clone's DB", async () => {
    const a = await tempRepo();
    brain(a, "init", "--yes", "--tools", "");
    writeFileSync(join(a, "README.md"), "hi\n");
    gitWithBrain(a, "add", "README.md", ".brain/brain.config.json");
    gitWithBrain(a, "commit", "-qm", "init");

    const b = `${a}-b`;
    execFileSync("git", ["clone", "-q", a, b]);
    brain(b, "init", "--yes", "--tools", "");

    const task = brainJson<Rec>(a, "task", "create", "From a").data;
    writeFileSync(join(a, "README.md"), "changed\n");
    gitWithBrain(a, "add", "README.md");
    gitWithBrain(a, "commit", "-qm", "work");
    const committed = gitWithBrain(a, "show", "--name-only", "--format=", "HEAD");
    expect(committed).toContain(`.brain/tasks/${task.id}.json`);

    gitWithBrain(b, "pull", "-q", "--no-rebase", "origin", "main");
    expect(brainJson<Rec>(b, "task", "show", task.id).data.title).toBe("From a");
  });
});
