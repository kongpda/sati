import { mkdtempSync, writeFileSync } from "node:fs";
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
  });
});
