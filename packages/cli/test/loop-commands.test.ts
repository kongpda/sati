import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, sati, satiJson, tempRepo } from "./helpers.js";

describe("loop commands", () => {
  it("claims the next task, records a handoff and imports a plan once", async () => {
    const dir = await tempRepo({ init: true });
    const created = satiJson<{ id: string }>(dir, "task", "create", "Write the brief");
    expect(created.code).toBe(0);
    const next = satiJson<{ id: string }>(dir, "next");
    expect(next.code).toBe(0);
    expect(next.data.id).toBe(created.data.id);
    expect(
      sati(dir, "handoff", created.data.id, "--done", "draft", "--next", "review it").code,
    ).toBe(0);
    writeFileSync(join(dir, "plan.md"), "# Ship\n\n- [ ] Write tests\n- [x] Skip me\n");
    const imported = satiJson<{ added: { title: string }[] }>(dir, "plan", "import", "plan.md");
    expect(imported.code).toBe(0);
    expect(imported.data.added.map((row) => row.title)).toContain("Write tests");
    expect(imported.data.added.map((row) => row.title)).not.toContain("Skip me");
    const again = satiJson<{ added: unknown[] }>(dir, "plan", "import", "plan.md");
    expect(again.data.added).toHaveLength(0);
    const fresh = satiJson<{ id: string }>(dir, "task", "create", "Disposable");
    const rows = satiJson<{ id: string; verb: string; entity: string; entityId: string }[]>(
      dir,
      "activity",
    );
    const row = rows.data.find(
      (item) => item.verb === "create" && item.entity === "task" && item.entityId === fresh.data.id,
    );
    expect(row).toBeDefined();
    expect(sati(dir, "undo", row?.id ?? "").code).toBe(0);
    const settings = satiJson<{ review: string; autoContinue: boolean }>(
      dir,
      "settings",
      "--review",
      "none",
      "--auto-continue",
    );
    expect(settings.data).toMatchObject({ review: "none", autoContinue: true });
    // citty turns `--no-auto-continue` into `auto-continue: false`; it must switch the setting off.
    const off = satiJson<{ autoContinue: boolean }>(dir, "settings", "--no-auto-continue");
    expect(off.data.autoContinue).toBe(false);
  });

  // PLAN Phase 5b: a person takes over or releases an agent's task; another agent cannot.
  it("releases and takes over claims: people may, other agents may not", async () => {
    const dir = await tempRepo({ init: true });
    const agent = (name: string) => ({ SATI_ACTOR: name, AI_AGENT: "codex_1_agent" });
    const created = satiJson<{ id: string }>(dir, "task", "create", "Design flyer");
    const id = created.data.id;
    expect(run(dir, ["task", "claim", id], agent("codex-a")).code).toBe(0);
    // Exit 8 (INVALID_TRANSITION): only a person may override a live claim (review 9.7).
    expect(run(dir, ["task", "release", id, "--force"], agent("codex-b")).code).toBe(8);
    expect(run(dir, ["task", "take-over", id], agent("codex-b")).code).toBe(8);
    // Exit 4 is CONFLICT: the claim is live and belongs to someone else; force would override it.
    expect(run(dir, ["task", "release", id], { SATI_ACTOR: "dara" }).code).toBe(4);
    const taken = run(dir, ["task", "take-over", id, "--json"], { SATI_ACTOR: "dara" });
    expect(taken.code).toBe(0);
    const task = JSON.parse(taken.stdout) as { status: string; claim: { token: number } };
    expect(task.status).toBe("in_progress");
    // The person's own writes carry their token, and the agent's no longer go through.
    expect(run(dir, ["task", "update", id, "--body", "v2"], { SATI_ACTOR: "dara" }).code).toBe(0);
    expect(run(dir, ["task", "update", id, "--body", "v3"], agent("codex-a")).code).toBe(4);
    const freed = run(dir, ["task", "release", id, "--json"], { SATI_ACTOR: "dara" });
    expect(JSON.parse(freed.stdout)).toMatchObject({ status: "todo", claim: null });
  });

  it("keeps commas inside a brace glob and names the right command in usage hints", async () => {
    const dir = await tempRepo({ init: true });
    const args = ["feature", "create", "Docs", "--paths", "src/{a,b}/**,docs/**"];
    const feature = satiJson<{ paths: string[] }>(dir, ...args);
    expect(feature.data.paths).toEqual(["src/{a,b}/**", "docs/**"]);
    expect(sati(dir, "bogus").stderr).toContain("Run `sati --help`");
    expect(sati(dir, "task", "bogus").stderr).toContain("Run `sati task --help`");
  });

  it("creates a personal workspace outside a repository when SATI_YES=1", () => {
    const home = mkdtempSync(join(tmpdir(), "sati-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "sati-cwd-"));
    const env = { HOME: home, SATI_YES: "1" };
    const created = run(cwd, ["task", "create", "Buy milk", "--json"], env);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Buy milk");
    const listed = run(cwd, ["projects"], env);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("personal");
    const other = mkdtempSync(join(tmpdir(), "sati-home-"));
    const refused = run(cwd, ["task", "create", "Nope"], { HOME: other });
    expect(refused.code).not.toBe(0);

    // The folder outlived its registry entry. A raw EEXIST came out here, after a second
    // database had been created for the same folder.
    rmSync(join(home, ".sati", "projects.json"));
    const again = run(cwd, ["task", "create", "Twice"], env);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("A personal workspace already exists");
    expect(again.stderr).not.toContain("EEXIST");
  });
});
