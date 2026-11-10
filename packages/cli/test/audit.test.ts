import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shortHandle } from "@sati/core";
import { describe, expect, it } from "vitest";
import { run, sati, satiJson, tempRepo } from "./helpers.js";

const tempDir = () => realpathSync.native(mkdtempSync(join(tmpdir(), "sati-audit-")));

// Bugs found by the 2026-11-09 command audit (PLAN Phase 5d). Each one lost data, hid the real
// problem, or sent the user to the wrong fix.
type Err = { error: { code: string; message: string; hint?: string } };
type Rec = { id: string; body: string };

describe("command audit fixes", () => {
  it("handoff with no flags reads the note instead of wiping it", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Rec>(dir, "task", "create", "Ship it").data;
    expect(satiJson<Err>(dir, "handoff", task.id).data.error.code).toBe("NOT_FOUND");
    expect(sati(dir, "handoff", task.id, "--next", "Write the docs").code).toBe(0);
    const read = sati(dir, "handoff", task.id);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("Write the docs");
    // Reading twice is still reading: the note was not replaced by an empty one.
    expect(satiJson<Rec>(dir, "handoff", task.id).data.body).toContain("Write the docs");
  });

  it("restore finds a deleted record by its short handle", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Rec>(dir, "task", "create", "Gone soon").data;
    const note = satiJson<Rec>(dir, "note", "create", "Gone note").data;
    for (const [entity, rec] of [
      ["task", task],
      ["note", note],
    ] as const) {
      expect(sati(dir, entity, "delete", rec.id).code).toBe(0);
      const restored = satiJson<Rec>(dir, entity, "restore", shortHandle(rec.id));
      expect(restored.code).toBe(0);
      expect(restored.data.id).toBe(rec.id);
    }
  });

  // Threads match links by full id, so a handle stored as typed would never show the note there.
  it("note create and update store a short-handle link as the full id, as MCP does", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Rec>(dir, "task", "create", "Linked").data;
    const links = `${shortHandle(task.id)},https://example.com`;
    const note = satiJson<Rec & { links: string[] }>(dir, "note", "create", "N", "--links", links);
    expect(note.data.links).toEqual([task.id, "https://example.com"]);
    const updated = satiJson<Rec & { links: string[] }>(
      dir,
      "note",
      "update",
      note.data.id,
      "--links",
      shortHandle(task.id),
    );
    expect(updated.data.links).toEqual([task.id]);
  });

  it("plan import reports a missing file or a folder as the user's mistake", async () => {
    const dir = await tempRepo({ init: true });
    const missing = satiJson<Err>(dir, "plan", "import", "nofile.md");
    expect(missing.code).toBe(3);
    expect(missing.data.error.message).toContain("nofile.md");
    mkdirSync(join(dir, "plans"));
    expect(satiJson<Err>(dir, "plan", "import", "plans").code).toBe(2);
  });

  it("- reads a body or a plan from stdin instead of storing a dash", async () => {
    const dir = await tempRepo({ init: true });
    const note = run(
      dir,
      ["note", "create", "Piped", "--body", "-", "--json"],
      {},
      "line one\nline two\n",
    );
    expect(JSON.parse(note.stdout).body).toBe("line one\nline two\n");
    const plan = run(
      dir,
      ["plan", "import", "-", "--dry-run", "--json"],
      {},
      "# M1\n- [ ] A task\n",
    );
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.stdout).added).toContainEqual(
      expect.objectContaining({ kind: "task", title: "A task" }),
    );
  });

  it("complete on an unclaimed task says to claim it first", async () => {
    const dir = await tempRepo({ init: true });
    const task = satiJson<Rec>(dir, "task", "create", "Not started").data;
    const r = satiJson<Err>(dir, "task", "complete", task.id, "--summary", "x", "--files", "a.ts");
    expect(r.code).toBe(8);
    expect(r.data.error.hint).toContain("task claim");
  });

  it("scan --apply with nothing to propose does not claim it created anything", async () => {
    const dir = await tempRepo({ init: true });
    writeFileSync(join(dir, "README.md"), "hi\n");
    const r = satiJson<{ proposals: unknown[]; created: boolean }>(dir, "scan", "--apply");
    expect(r.data.proposals).toEqual([]);
    expect(r.data.created).toBe(false);
  });

  it("errors outside a project keep their code and hint, and usage hints name real commands", () => {
    const dir = tempDir();
    const serve = sati(dir, "serve");
    expect(serve.code).toBe(6);
    expect(serve.stderr).toContain("sati init");
    const driver = sati(dir, "merge-driver", "a");
    expect(driver.code).toBe(2);
    expect(driver.stderr).toContain("Run `sati merge-driver --help`");
  });

  // The config file has no id and one allowed `version`. Merged as a record its version would be
  // bumped, and every later command in the repo would refuse the config.
  it("the merge driver leaves a file that is not a record to git", () => {
    const dir = tempDir();
    const config = `${JSON.stringify({ version: 1, mode: "git" })}\n`;
    for (const name of ["base", "ours", "theirs"]) writeFileSync(join(dir, name), config);
    const r = sati(dir, "merge-driver", "base", "ours", "theirs");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not a record file");
    expect(readFileSync(join(dir, "ours"), "utf8")).toBe(config);
  });

  it("guard says when more than one thing to check was given", async () => {
    const dir = await tempRepo({ init: true });
    const r = satiJson<Err>(dir, "guard", "--staged", "--paths", "a.ts");
    expect(r.data.error.message).toBe("Pick one thing to check.");
  });
});
