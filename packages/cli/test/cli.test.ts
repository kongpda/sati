import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

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
describe("sati CLI", () => {
  it("before init, every command says to run `sati init` with exit code 6", async () => {
    const dir = await tempRepo();
    const r = satiJson<Err>(dir, "task", "list");
    expect(r.code).toBe(6);
    expect(r.data.error).toMatchObject({ code: "NOT_INITIALIZED", hint: "Run `sati init`." });
    expect(sati(dir, "task", "list").stderr).toContain("hint: Run `sati init`.");
  });

  // Agents pass the short handles the CLI prints. `decision delete` once looked a live decision up
  // among deleted ones, so a handle failed with "not found" while a full id worked.
  it("deletes and restores tasks, notes and decisions by short handle", async () => {
    const dir = await tempRepo({ init: true });
    const handle = (id: string) => `${id.split("_")[0]}_${id.slice(-6).toLowerCase()}`;
    const made = {
      task: satiJson<Rec>(dir, "task", "create", "Old task").data,
      note: satiJson<Rec>(dir, "note", "create", "Old note", "--body", "x").data,
      decision: satiJson<Rec>(dir, "decision", "record", "Old call", "--decision", "x").data,
    };
    for (const [entity, rec] of Object.entries(made)) {
      const gone = satiJson<Rec>(dir, entity, "delete", handle(rec.id));
      expect(gone.code, `${entity} delete`).toBe(0);
      expect(gone.data.deletedAt).not.toBeNull();
      const back = satiJson<Rec>(dir, entity, "restore", handle(rec.id));
      expect(back.code, `${entity} restore`).toBe(0);
      expect(back.data.deletedAt).toBeNull();
    }
  });

  // Trial: `task list --json` and `show --json` were mostly merge stamps; agents read them often.
  it("lists short task rows by default, whole records with --full, and never prints stamps", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "Book catering", "--body", "Menu A and B").data;
    const [short] = satiJson<Record<string, unknown>[]>(dir, "task", "list").data;
    expect(short).toMatchObject({ id: t.id, title: "Book catering", status: "todo" });
    expect(short).not.toHaveProperty("body");
    const [full] = satiJson<Record<string, unknown>[]>(dir, "task", "list", "--full").data;
    expect(full).toMatchObject({ body: "Menu A and B" });
    const shown =
      sati(dir, "task", "show", t.id, "--json").stdout + sati(dir, "task", "show", t.id).stdout;
    expect(full).not.toHaveProperty("stamps");
    expect(shown).not.toContain("stamps");
  });

  it("runs a task from creation to completion, gating the ready list on dependencies", async () => {
    const dir = await tempRepo({ init: true });
    const dep = satiJson<Rec>(dir, "task", "create", "Schema", "--labels", "db,core").data;
    expect(dep).toMatchObject({ status: "todo", labels: ["db", "core"] });
    const handle = `tsk_${dep.id.slice(-6).toLowerCase()}`;
    const next = satiJson<Rec>(dir, "task", "create", "API", "--depends", handle).data;
    expect(next.dependsOn).toEqual([dep.id]);

    const ready = () => satiJson<Rec[]>(dir, "task", "list", "--ready").data.map((t) => t.id);
    expect(ready()).toEqual([dep.id]);

    expect(sati(dir, "task", "update", handle, "--status", "in_progress").code).toBe(0);
    // Completing needs proof of work: a summary and the files touched.
    expect(sati(dir, "task", "complete", handle).code).toBe(2);
    const done = satiJson<Rec>(
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
    expect(sati(dir, "task", "show", handle).stdout).toContain("Added tables");
  });

  // Agents without MCP claim through the CLI; a second actor must be told who holds the task.
  it("claims a task and refuses another actor with CONFLICT (exit 4)", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "x").data;
    const claimed = satiJson<Rec>(dir, "task", "claim", t.id);
    expect(claimed.code).toBe(0);
    expect(claimed.data).toMatchObject({ status: "in_progress" });
    const other = run(dir, ["task", "claim", t.id, "--json"], { SATI_ACTOR: "someone-else" });
    expect(other.code).toBe(4);
    expect(JSON.parse(other.stdout).error.message).toContain("tester");
  });

  // PLAN review fix 2: writes on a claimed task need the fencing token. Each CLI call is a new
  // process, so the holder's own token is used when --token is omitted; nobody else gets it.
  it("fills in the holder's fencing token, and refuses others and stale tokens", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "x").data;
    const claimed = satiJson<Rec & { claim: { token: number } }>(dir, "task", "claim", t.id).data;
    expect(sati(dir, "task", "claim", t.id).stdout).toMatch(/, token \d+\n$/);

    const other = run(dir, ["task", "update", t.id, "--body", "theirs", "--json"], {
      SATI_ACTOR: "someone-else",
    });
    expect(other.code).toBe(4);
    expect(JSON.parse(other.stdout).error.message).toContain("fencing token");
    // The re-claim above issued a new token, so the first one is stale now.
    const stale = ["task", "update", t.id, "--body", "x", "--token", String(claimed.claim.token)];
    expect(sati(dir, ...stale).code).toBe(4);

    expect(sati(dir, "task", "update", t.id, "--body", "mine").code).toBe(0);
    const done = satiJson<Rec>(dir, "task", "complete", t.id, "--summary", "s", "--files", "a");
    expect(done).toMatchObject({ code: 0, data: { status: "done", body: "mine" } });
  });

  // The SessionStart hook runs `sati brief --format=agent` and injects stdout as is.
  it("prints the brief as Markdown, and as JSON with its token estimate", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "Ready one").data;
    const md = sati(dir, "brief", "--format=agent");
    expect(md.code).toBe(0);
    expect(md.stdout).toContain("# sati brief: Demo");
    expect(md.stdout).toContain(`tsk_${t.id.slice(-6).toLowerCase()} [medium] Ready one`);
    const j = satiJson<{ markdown: string; tokens: number }>(dir, "brief", "--format", "short");
    expect(j.data.tokens).toBeGreaterThan(0);
    expect(satiJson(dir, "brief", "--format", "long").code).toBe(5);
    // A brief run as a command is read by an agent that may have no MCP client; the hook, which
    // sati writes next to the MCP config, says so with --tools=mcp.
    expect(md.stdout.trimEnd().split("\n").at(-1)).toMatch(/^Tools: CLI \(--json on every/u);
    expect(sati(dir, "brief", "--tools=mcp").stdout.trimEnd().endsWith("Tools: MCP.")).toBe(true);
    const bad = sati(dir, "brief", "--tools=both");
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--tools must be mcp or cli.");
  });

  it("writes a changelog from release notes and a feature list from shipped features", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "Card crash", "--labels", "bug").data;
    sati(dir, "task", "update", t.id, "--status", "in_progress");
    const done = satiJson<Rec>(
      dir,
      "task",
      "complete",
      t.id,
      "--summary",
      "Guarded null card",
      "--release-note",
      "Paying by card no longer crashes",
      "--files",
      "src/pay.ts",
    );
    expect(done.data.completion).toMatchObject({ releaseNote: "Paying by card no longer crashes" });
    const log = sati(dir, "changes", "--format", "changelog");
    expect(log.code).toBe(0);
    expect(log.stdout).toContain("### Fixed\n- Paying by card no longer crashes");
    // A person's last session ends at their last write; a teammate's work after it is news.
    run(dir, ["decision", "record", "Ship on Friday", "--decision", "x"], { SATI_ACTOR: "kong" });
    const news = sati(dir, "changes", "--since", "last-session").stdout;
    expect(news).toContain("Ship on Friday");
    expect(news).not.toContain("Guarded null card");
    expect(sati(dir, "changes", "--since", "soon").code).toBe(5);
    expect(sati(dir, "changes", "--format", "pdf").code).toBe(5);

    sati(dir, "feature", "create", "Search", "--status", "shipped", "--acceptance", "Typos match");
    const md = sati(dir, "feature", "list", "--format", "md");
    expect(md.stdout).toBe("# Demo features\n\n### Search\n\n- Typos match\n");
    expect(sati(dir, "feature", "list", "--format", "csv").code).toBe(2);
  });

  it("applies a template, with the project's own from .sati/templates/", async () => {
    const dir = await tempRepo({ init: true });
    const dry = sati(dir, "template", "apply", "campaign", "--date", "2027-01-31", "--dry-run");
    expect(dry.stdout).toContain("Would create Marketing campaign with 14 tasks");
    expect(satiJson<Rec[]>(dir, "milestone", "list").data).toEqual([]);

    mkdirSync(join(dir, ".sati", "templates"), { recursive: true });
    writeFileSync(
      join(dir, ".sati", "templates", "offsite.md"),
      "# Offsite\n## Go (-1w)\n- [ ] Book bus\n  - [ ] Get quotes\n",
    );
    expect(sati(dir, "template", "list").stdout).toContain(
      "offsite          Offsite (1 task in 1 stage, .sati/templates/offsite.md)",
    );
    const made = satiJson<{ milestone: Rec; taskIds: string[] }>(
      dir,
      "template",
      "apply",
      "offsite",
      "--date",
      "2027-01-31",
    );
    expect(made.code).toBe(0);
    const task = satiJson<Rec>(dir, "task", "show", made.data.taskIds[0] ?? "").data;
    expect(task).toMatchObject({
      title: "Book bus",
      dueDate: "2027-01-24",
      milestoneId: made.data.milestone.id,
      checklist: [{ text: "Get quotes", done: false }],
    });
    expect(sati(dir, "template", "apply", "offsite").code).toBe(4);
    expect(sati(dir, "template", "apply", "wedding").code).toBe(3);
    expect(sati(dir, "template", "show", "release").stdout).toContain("## Freeze (-1w)");
  });

  it("saves cards, recalls them, and keeps private ones out of .sati/", async () => {
    const dir = await tempRepo({ init: true });
    const saved = sati(
      dir,
      "card",
      "put",
      "venue/quote.pdf",
      "--summary",
      "Hall B quote",
      "--facts",
      '["Price: $2,400, incl. tax", "Valid until 1 December"]',
      "--seen",
      "2026-11-03T09:15Z",
    );
    expect(saved.code).toBe(0);
    sati(
      dir,
      "card",
      "put",
      "hr/pay.xlsx",
      "--summary",
      "Pay bands",
      "--facts",
      "Band A: 1,000\nBand B: 2,000",
      "--private",
    );
    const shown = sati(dir, "card", "show", "venue").stdout;
    expect(shown).toContain("venue/quote.pdf  [fresh]");
    expect(shown).toContain("  - Price: $2,400, incl. tax");
    expect(sati(dir, "card", "show", "hr").stdout).toContain(
      "(private)\n  Pay bands\n  - Band A: 1,000\n  - Band B: 2,000",
    );
    const r = sati(dir, "recall", "what is the hall b price?");
    expect(r.stdout).toContain("card ");
    expect(r.stdout).toContain("  - Price: $2,400, incl. tax");
    expect(sati(dir, "card", "put", "x", "--summary", "y", "--facts", "[oops").code).toBe(2);
    sati(dir, "export");
    const files = readdirSync(join(dir, ".sati", "context")).map((f) =>
      readFileSync(join(dir, ".sati", "context", f), "utf8"),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("Hall B quote");
  });

  // The Stop hook blocks once while the agent holds a claim, then lets the stop through.
  it("nudge blocks a stop while the caller holds a task, once", async () => {
    const dir = await tempRepo({ init: true });
    expect(sati(dir, "nudge").stdout).toBe("");
    const t = satiJson<Rec>(dir, "task", "create", "Wire hooks").data;
    sati(dir, "task", "claim", t.id);
    const stop = (active: boolean) =>
      spawnSync(process.execPath, [bin, "nudge"], {
        cwd: dir,
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "Stop", stop_hook_active: active }),
        env: { ...process.env, SATI_ACTOR: "tester", CLAUDECODE: "", AI_AGENT: "" },
      });
    const first = stop(false);
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout) as { decision: string; reason: string };
    expect(out.decision).toBe("block");
    expect(out.reason).toContain(`tsk_${t.id.slice(-6).toLowerCase()} (Wire hooks)`);
    expect(stop(true).stdout).not.toContain("decision");
    // Another actor's claim is not ours to finish.
    expect(run(dir, ["nudge"], { SATI_ACTOR: "someone-else" }).stdout).toBe("");
  });

  // Why: an agent set up with `init --cli-only` has no MCP tools; a reminder that says "call
  // task_complete" sends it to a tool it cannot call.
  it("a cli-only nudge names shell commands, because the agent has no MCP tools", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "Wire hooks").data;
    sati(dir, "task", "claim", t.id);
    const handle = `tsk_${t.id.slice(-6).toLowerCase()}`;
    const cli = sati(dir, "nudge", "--tools", "cli").stdout;
    expect(cli).toContain(`sati task complete ${handle} --summary`);
    expect(cli).not.toMatch(/task_complete|task_update/u);
    expect(sati(dir, "nudge").stdout).toContain("call task_complete");
  });

  it("refuses to mark done through update, pointing at `complete` (exit 8)", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "x").data;
    const r = satiJson<Err>(dir, "task", "update", t.id, "--status", "done");
    expect(r.code).toBe(8);
    expect(r.data.error.code).toBe("INVALID_TRANSITION");
  });

  it("sets, lists and clears a task's effort", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "Fix typo", "--effort", "light").data;
    satiJson<Rec>(dir, "task", "create", "Plain");
    expect(t.effort).toBe("light");
    const light = satiJson<Rec[]>(dir, "task", "list", "--effort", "light").data;
    expect(light.map((r) => r.title)).toEqual(["Fix typo"]);
    expect(sati(dir, "task", "list").stdout).toMatch(/medium {2}light {2}Fix typo/u);
    const cleared = satiJson<Rec>(dir, "task", "update", t.id, "--effort", "none").data;
    expect(cleared.effort).toBeNull();
    expect(sati(dir, "task", "create", "x", "--effort", "huge").code).toBe(5);
  });

  it("rejects a stale --expected-version with CONFLICT (exit 4)", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "x").data;
    expect(sati(dir, "task", "update", t.id, "--priority", "high").code).toBe(0);
    const r = satiJson<Err>(dir, "task", "update", t.id, "--title", "y", "--expected-version", "1");
    expect(r.code).toBe(4);
    expect(r.data.error.code).toBe("CONFLICT");
  });

  it("removing a shipped feature needs a recorded decision", async () => {
    const dir = await tempRepo({ init: true });
    const f = satiJson<Rec>(dir, "feature", "create", "Login", "--status", "shipped").data;
    const t = satiJson<Rec>(dir, "task", "create", "Polish login", "--feature", f.id).data;
    expect(t.featureId).toBe(f.id);

    expect(sati(dir, "feature", "update", f.id, "--status", "removed").code).toBe(5);
    const d = satiJson<Rec>(
      dir,
      "decision",
      "record",
      "Drop password login",
      "--decision",
      "Use SSO only",
      "--features",
      f.id,
    ).data;
    const r = satiJson<Rec>(
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
    sati(dir, "note", "create", "Webhook retries", "--body", "Stripe retries for three days");
    sati(dir, "task", "create", "Handle webhook signature");
    const all = satiJson<{ entity: string }[]>(dir, "search", "webhook").data;
    expect(all.map((h) => h.entity).sort()).toEqual(["note", "task"]);
    const notes = satiJson<{ entity: string }[]>(dir, "search", "webhook", "--entities", "note");
    expect(notes.data.map((h) => h.entity)).toEqual(["note"]);
    expect(sati(dir, "search", "nothing-here").stdout).toContain("No matches.");
  });

  it("comments on a task by handle and lists the thread with the author's name", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<{ id: string }>(dir, "task", "create", "Book venue").data;
    const handle = `tsk_${t.id.slice(-6).toLowerCase()}`;
    expect(sati(dir, "comment", "add", handle, "Ask for the hall on level 2").stdout).toMatch(
      /^Commented on tsk_/,
    );
    const thread = sati(dir, "comment", "list", handle).stdout;
    expect(thread).toContain("tester");
    expect(thread).toContain("  Ask for the hall on level 2");
    const bad = sati(dir, "comment", "add", "feat_zzzzzz", "x");
    expect(bad).toMatchObject({
      code: 5,
      stderr: expect.stringContaining("task, note or decision"),
    });
    expect(sati(dir, "comment", "list", t.id).stdout).not.toContain("No comments");
  });

  it("reports usage errors with exit code 2, as JSON when asked", async () => {
    const dir = await tempRepo({ init: true });
    const missing = sati(dir, "task", "create");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("hint: Run `sati task create --help` for usage.");
    const unknown = satiJson<Err>(dir, "task", "nope");
    expect(unknown).toMatchObject({ code: 2, data: { error: { code: "USAGE" } } });
    expect(sati(dir, "task", "list", "--limit", "ten").code).toBe(2);
  });

  it("reports an ambiguous or unknown handle with its own exit code", async () => {
    const dir = await tempRepo({ init: true });
    expect(sati(dir, "task", "show", "tsk_zzzzzz").code).toBe(3);
    expect(sati(dir, "task", "show", "note_zzzzzz").code).toBe(5);
  });

  it("attributes writes to the caller's identity", async () => {
    const dir = await tempRepo({ init: true });
    const a = satiJson<Rec>(dir, "task", "create", "one").data;
    const b = satiJson<Rec>(dir, "task", "create", "two").data;
    expect(a.createdBy).toBe(b.createdBy);
    const other = JSON.parse(
      run(dir, ["task", "create", "three", "--json"], { SATI_ACTOR: "someone-else" }).stdout,
    ) as Rec;
    expect(other.createdBy).not.toBe(a.createdBy);
  });

  it("locks paths, refuses an overlapping lock from another agent, and releases", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Rec>(dir, "task", "create", "Billing").data;
    const held = satiJson<{ lock: Rec & { paths: string[] } }>(
      dir,
      "lock",
      "acquire",
      "src/billing/**,docs",
      "--task",
      task.id,
    );
    expect(held.code).toBe(0);
    expect(held.data.lock.paths).toEqual(["src/billing/**", "docs"]);

    const other = run(dir, ["lock", "acquire", "src/billing/a.ts"], { SATI_ACTOR: "codex" });
    expect(other.code).toBe(4);
    expect(other.stderr).toContain("locked (exclusive) by tester");
    expect(sati(dir, "lock", "list").stdout).toContain("src/billing/**, docs");

    expect(sati(dir, "lock", "release", held.data.lock.id).code).toBe(0);
    expect(sati(dir, "lock", "list").stdout).toContain("No locks.");
  });
});
