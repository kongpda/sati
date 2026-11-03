import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bin, brain, brainJson, run, tempRepo } from "./helpers.js";

interface Rec {
  id: string;
  status: string;
  version: number;
  createdBy: string;
  [k: string]: unknown;
}
interface Err {
  error: { code: string; message: string; hint: string | null };
}

// Agents branch on exit codes and JSON, so these tests pin both, not just the happy path.
describe("brain CLI", () => {
  it("before init, every command says to run `brain init` with exit code 6", async () => {
    const dir = await tempRepo();
    const r = brainJson<Err>(dir, "task", "list");
    expect(r.code).toBe(6);
    expect(r.data.error).toMatchObject({ code: "NOT_INITIALIZED", hint: "Run `brain init`." });
    expect(brain(dir, "task", "list").stderr).toContain("hint: Run `brain init`.");
  });

  it("runs a task from creation to completion, gating the ready list on dependencies", async () => {
    const dir = await tempRepo({ init: true });
    const dep = brainJson<Rec>(dir, "task", "create", "Schema", "--labels", "db,core").data;
    expect(dep).toMatchObject({ status: "todo", labels: ["db", "core"] });
    const handle = `tsk_${dep.id.slice(-6).toLowerCase()}`;
    const next = brainJson<Rec>(dir, "task", "create", "API", "--depends", handle).data;
    expect(next.dependsOn).toEqual([dep.id]);

    const ready = () => brainJson<Rec[]>(dir, "task", "list", "--ready").data.map((t) => t.id);
    expect(ready()).toEqual([dep.id]);

    expect(brain(dir, "task", "update", handle, "--status", "in_progress").code).toBe(0);
    // Completing needs proof of work: a summary and the files touched.
    expect(brain(dir, "task", "complete", handle).code).toBe(2);
    const done = brainJson<Rec>(
      dir,
      "task",
      "complete",
      handle,
      "--summary",
      "Added tables",
      "--files",
      "src/a.ts,src/b.ts",
    );
    expect(done.code).toBe(0);
    expect(done.data.completion).toMatchObject({ filesTouched: ["src/a.ts", "src/b.ts"] });
    expect(ready()).toEqual([next.id]);
    expect(brain(dir, "task", "show", handle).stdout).toContain("Added tables");
  });

  // Agents without MCP claim through the CLI; a second actor must be told who holds the task.
  it("claims a task and refuses another actor with CONFLICT (exit 4)", async () => {
    const dir = await tempRepo({ init: true });
    const t = brainJson<Rec>(dir, "task", "create", "x").data;
    const claimed = brainJson<Rec>(dir, "task", "claim", t.id);
    expect(claimed.code).toBe(0);
    expect(claimed.data).toMatchObject({ status: "in_progress" });
    const other = run(dir, ["task", "claim", t.id, "--json"], { BRAIN_ACTOR: "someone-else" });
    expect(other.code).toBe(4);
    expect(JSON.parse(other.stdout).error.message).toContain("tester");
  });

  // PLAN review fix 2: writes on a claimed task need the fencing token. Each CLI call is a new
  // process, so the holder's own token is used when --token is omitted; nobody else gets it.
  it("fills in the holder's fencing token, and refuses others and stale tokens", async () => {
    const dir = await tempRepo({ init: true });
    const t = brainJson<Rec>(dir, "task", "create", "x").data;
    const claimed = brainJson<Rec & { claim: { token: number } }>(dir, "task", "claim", t.id).data;
    expect(brain(dir, "task", "claim", t.id).stdout).toMatch(/, token \d+\n$/);

    const other = run(dir, ["task", "update", t.id, "--body", "theirs", "--json"], {
      BRAIN_ACTOR: "someone-else",
    });
    expect(other.code).toBe(4);
    expect(JSON.parse(other.stdout).error.message).toContain("fencing token");
    // The re-claim above issued a new token, so the first one is stale now.
    const stale = ["task", "update", t.id, "--body", "x", "--token", String(claimed.claim.token)];
    expect(brain(dir, ...stale).code).toBe(4);

    expect(brain(dir, "task", "update", t.id, "--body", "mine").code).toBe(0);
    const done = brainJson<Rec>(dir, "task", "complete", t.id, "--summary", "s", "--files", "a");
    expect(done).toMatchObject({ code: 0, data: { status: "done", body: "mine" } });
  });

  // The SessionStart hook runs `brain brief --format=agent` and injects stdout as is.
  it("prints the brief as Markdown, and as JSON with its token estimate", async () => {
    const dir = await tempRepo({ init: true });
    const t = brainJson<Rec>(dir, "task", "create", "Ready one").data;
    const md = brain(dir, "brief", "--format=agent");
    expect(md.code).toBe(0);
    expect(md.stdout).toContain("# brain brief: Demo");
    expect(md.stdout).toContain(`tsk_${t.id.slice(-6).toLowerCase()} [medium] Ready one`);
    const j = brainJson<{ markdown: string; tokens: number }>(dir, "brief", "--format", "short");
    expect(j.data.tokens).toBeGreaterThan(0);
    expect(brainJson(dir, "brief", "--format", "long").code).toBe(5);
  });

  // The Stop hook blocks once while the agent holds a claim, then lets the stop through.
  it("nudge blocks a stop while the caller holds a task, once", async () => {
    const dir = await tempRepo({ init: true });
    expect(brain(dir, "nudge").stdout).toBe("");
    const t = brainJson<Rec>(dir, "task", "create", "Wire hooks").data;
    brain(dir, "task", "claim", t.id);
    const stop = (active: boolean) =>
      spawnSync(process.execPath, [bin, "nudge"], {
        cwd: dir,
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: active }),
        env: { ...process.env, BRAIN_ACTOR: "tester", CLAUDECODE: "", AI_AGENT: "" },
      });
    const first = stop(false);
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain(`tsk_${t.id.slice(-6).toLowerCase()} (Wire hooks)`);
    expect(stop(true).stdout).not.toContain("decision");
    // Another actor's claim is not ours to finish.
    expect(run(dir, ["nudge"], { BRAIN_ACTOR: "someone-else" }).stdout).toBe("");
  });

  it("refuses to mark done through update, pointing at `complete` (exit 8)", async () => {
    const dir = await tempRepo({ init: true });
    const t = brainJson<Rec>(dir, "task", "create", "x").data;
    const r = brainJson<Err>(dir, "task", "update", t.id, "--status", "done");
    expect(r.code).toBe(8);
    expect(r.data.error.code).toBe("INVALID_TRANSITION");
  });

  it("rejects a stale --expected-version with CONFLICT (exit 4)", async () => {
    const dir = await tempRepo({ init: true });
    const t = brainJson<Rec>(dir, "task", "create", "x").data;
    expect(brain(dir, "task", "update", t.id, "--priority", "high").code).toBe(0);
    const r = brainJson<Err>(
      dir,
      "task",
      "update",
      t.id,
      "--title",
      "y",
      "--expected-version",
      "1",
    );
    expect(r.code).toBe(4);
    expect(r.data.error.code).toBe("CONFLICT");
  });

  it("removing a shipped feature needs a recorded decision", async () => {
    const dir = await tempRepo({ init: true });
    const f = brainJson<Rec>(dir, "feature", "create", "Login", "--status", "shipped").data;
    const t = brainJson<Rec>(dir, "task", "create", "Polish login", "--feature", f.id).data;
    expect(t.featureId).toBe(f.id);

    expect(brain(dir, "feature", "update", f.id, "--status", "removed").code).toBe(5);
    const d = brainJson<Rec>(
      dir,
      "decision",
      "record",
      "Drop password login",
      "--decision",
      "Use SSO only",
      "--features",
      f.id,
    ).data;
    const r = brainJson<Rec>(
      dir,
      "feature",
      "update",
      f.id,
      "--status",
      "removed",
      "--decision",
      d.id,
    );
    expect(r.code).toBe(0);
    expect(r.data.status).toBe("removed");
  });

  it("searches notes, tasks and decisions", async () => {
    const dir = await tempRepo({ init: true });
    brain(dir, "note", "create", "Webhook retries", "--body", "Stripe retries for three days");
    brain(dir, "task", "create", "Handle webhook signature");
    const all = brainJson<{ entity: string }[]>(dir, "search", "webhook").data;
    expect(all.map((h) => h.entity).sort()).toEqual(["note", "task"]);
    const notes = brainJson<{ entity: string }[]>(dir, "search", "webhook", "--entities", "note");
    expect(notes.data.map((h) => h.entity)).toEqual(["note"]);
    expect(brain(dir, "search", "nothing-here").stdout).toContain("No matches.");
  });

  it("reports usage errors with exit code 2, as JSON when asked", async () => {
    const dir = await tempRepo({ init: true });
    const missing = brain(dir, "task", "create");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("hint: Run `brain task create --help` for usage.");
    const unknown = brainJson<Err>(dir, "task", "nope");
    expect(unknown).toMatchObject({ code: 2, data: { error: { code: "USAGE" } } });
    expect(brain(dir, "task", "list", "--limit", "ten").code).toBe(2);
  });

  it("reports an ambiguous or unknown handle with its own exit code", async () => {
    const dir = await tempRepo({ init: true });
    expect(brain(dir, "task", "show", "tsk_zzzzzz").code).toBe(3);
    expect(brain(dir, "task", "show", "note_zzzzzz").code).toBe(5);
  });

  it("attributes writes to the caller's identity", async () => {
    const dir = await tempRepo({ init: true });
    const a = brainJson<Rec>(dir, "task", "create", "one").data;
    const b = brainJson<Rec>(dir, "task", "create", "two").data;
    expect(a.createdBy).toBe(b.createdBy);
    const other = JSON.parse(
      run(dir, ["task", "create", "three", "--json"], { BRAIN_ACTOR: "someone-else" }).stdout,
    ) as Rec;
    expect(other.createdBy).not.toBe(a.createdBy);
  });

  it("locks paths, refuses an overlapping lock from another agent, and releases", async () => {
    const dir = await tempRepo({ init: true });
    const task = brainJson<Rec>(dir, "task", "create", "Billing").data;
    const held = brainJson<{ lock: Rec & { paths: string[] } }>(
      dir,
      "lock",
      "acquire",
      "src/billing/**,docs",
      "--task",
      task.id,
    );
    expect(held.code).toBe(0);
    expect(held.data.lock.paths).toEqual(["src/billing/**", "docs"]);

    const other = run(dir, ["lock", "acquire", "src/billing/a.ts"], { BRAIN_ACTOR: "codex" });
    expect(other.code).toBe(4);
    expect(other.stderr).toContain("locked (exclusive) by tester");
    expect(brain(dir, "lock", "list").stdout).toContain("src/billing/**, docs");

    expect(brain(dir, "lock", "release", held.data.lock.id).code).toBe(0);
    expect(brain(dir, "lock", "list").stdout).toContain("No locks.");
  });
});
