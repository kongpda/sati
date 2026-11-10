import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory, initProject, SEARCHABLE, systemClock } from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { pruneProjects, readProjects, rememberProject } from "../src/projects.js";
import { readStdin } from "../src/runtime.js";
import { createUiApp, sessionToken } from "../src/ui/server.js";
import { bin, run, sati, satiJson, tempRepo } from "./helpers.js";

// Review WP5: CLI flags and output that disagreed with each other or with what the user meant.

interface Rec {
  id: string;
  labels: string[];
  featureId: string | null;
  parentId: string | null;
  dependsOn: string[];
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

describe("task flags", () => {
  // Why: `task list` took --label and create/update took --labels, and each hint suggested the
  // other spelling, so the first guess failed on two of the three commands.
  it("accepts --label and --labels on list, create and update", async () => {
    const dir = await tempRepo({ init: true });
    const a = satiJson<Rec>(dir, "task", "create", "A", "--label", "ui").data;
    const b = satiJson<Rec>(dir, "task", "create", "B", "--labels", "ui,db").data;
    expect(a.labels).toEqual(["ui"]);
    expect(b.labels).toEqual(["ui", "db"]);
    const updated = satiJson<Rec>(dir, "task", "update", a.id, "--label", "db").data;
    expect(updated.labels).toEqual(["db"]);
    expect(satiJson<Rec>(dir, "task", "update", b.id, "--labels", "x").data.labels).toEqual(["x"]);
    const ids = (flag: string) =>
      satiJson<Rec[]>(dir, "task", "list", flag, "db").data.map((t) => t.id);
    expect(ids("--label")).toEqual([a.id]);
    expect(ids("--labels")).toEqual([a.id]);
  });

  // Why: --milestone, --due, --effort and --assign took `none`, but --feature none failed with
  // `"none" is not a feature id`, so a task could not be taken out of a feature from the CLI.
  it("clears feature, parent and depends with none", async () => {
    const dir = await tempRepo({ init: true });
    const feature = satiJson<Rec>(dir, "feature", "create", "Billing").data;
    const parent = satiJson<Rec>(dir, "task", "create", "Parent").data;
    const dep = satiJson<Rec>(dir, "task", "create", "Dep").data;
    const t = satiJson<Rec>(dir, "task", "create", "Child", "--feature", feature.id).data;
    const set = satiJson<Rec>(
      dir,
      "task",
      "update",
      t.id,
      "--parent",
      parent.id,
      "--depends",
      dep.id,
    ).data;
    expect(set).toMatchObject({ featureId: feature.id, parentId: parent.id, dependsOn: [dep.id] });
    const cleared = satiJson<Rec>(
      dir,
      "task",
      "update",
      t.id,
      "--feature",
      "none",
      "--parent",
      "none",
      "--depends",
      "none",
    ).data;
    expect(cleared).toMatchObject({ featureId: null, parentId: null, dependsOn: [] });
  });
});

describe("actor filters", () => {
  // Why: `changes --actor` with a misspelt name filtered by the name itself and printed
  // "nothing changed", which reads as a true answer; MCP `changes` took only a full actor id.
  it("changes and activity refuse an unknown actor name, and take a handle", async () => {
    const dir = await tempRepo({ init: true });
    sati(dir, "task", "create", "A");
    const bad = run(dir, ["changes", "--actor", "nobody", "--json"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain("NOT_FOUND");
    expect(run(dir, ["activity", "--actor", "nobody"]).code).not.toBe(0);
    const rows = satiJson<{ actorId: string }[]>(dir, "activity").data;
    const actorId = rows[0]?.actorId ?? "";
    const handle = `actr_${actorId.slice(-6).toLowerCase()}`;
    const byHandle = satiJson<{ actorId: string }[]>(dir, "activity", "--actor", handle).data;
    expect(byHandle.length).toBe(rows.filter((r) => r.actorId === actorId).length);
    expect(byHandle.length).toBeGreaterThan(0);
    expect(sati(dir, "changes", "--actor", handle).code).toBe(0);
  });
});

describe("help", () => {
  // Why: `search --entities` accepted `context`, but the help listed only four kinds, so card
  // search could not be found from the CLI. `card show --help` printed `sati card get`.
  it("search help lists every searchable kind, and card show names itself", async () => {
    const dir = await tempRepo({ init: true });
    const help = run(dir, ["search", "--help"]);
    for (const kind of SEARCHABLE) expect(help.stdout).toContain(kind);
    expect(run(dir, ["card", "show", "--help"]).stdout).toContain("card show");
  });
});

describe("guard paths", () => {
  // Why: a path outside the repo was dropped without a word, and guard printed "allowed" for a
  // change it never checked.
  it("refuses a path outside the repository", async () => {
    const dir = await tempRepo({ init: true });
    const r = run(dir, ["guard", "--paths", "../elsewhere.ts"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("outside this repository");
  });
});

describe("line endings", () => {
  // Why: a clone with core.autocrlf=true (the Windows default) checked .sati/ files out with
  // CRLF, and the first `sync export` rewrote every unchanged record.
  it("a clone with core.autocrlf keeps .sati/ records unchanged", async () => {
    const dir = await tempRepo();
    expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
    sati(dir, "task", "create", "Hello");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const clone = `${dir}-clone`;
    git(dir, "clone", "-q", "-c", "core.autocrlf=true", dir, clone);
    const task = git(clone, "ls-files", ".sati/tasks").trim();
    expect(readFileSync(join(clone, task), "utf8")).not.toContain("\r");
    expect(sati(clone, "init", "--yes", "--tools", "").code).toBe(0);
    expect(sati(clone, "sync", "export").stdout).toContain("Exported 0 changed");
  });
});

describe("stdin", () => {
  // Why: `--body -` with nothing piped in saved an empty note, silently losing the text the user
  // thought they were piping.
  it("refuses --body - when stdin is empty", async () => {
    const dir = await tempRepo({ init: true });
    const r = run(dir, ["note", "create", "Empty", "--body", "-"], {}, "");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Nothing arrived on stdin.");
    expect(satiJson<unknown[]>(dir, "note", "list").data).toEqual([]);
  });

  // Why: `sati guard --hook` typed in a terminal read stdin until Ctrl-D and seemed to hang.
  it("reads nothing from a terminal stdin", () => {
    const stdin = process.stdin as { isTTY?: boolean | undefined };
    const was = stdin.isTTY;
    stdin.isTTY = true;
    try {
      expect(readStdin()).toBe("");
    } finally {
      stdin.isTTY = was;
    }
  });

  // Exit 1, not 2: Claude Code treats exit 2 from a PreToolUse hook as a block.
  it("guard --hook with no input fails with a hint instead of waiting", async () => {
    const dir = await tempRepo({ init: true });
    const r = run(dir, ["guard", "--hook"], {}, "");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("PreToolUse");
  });
});

describe("review", () => {
  async function reviewRepo() {
    const dir = await tempRepo({ init: true });
    mkdirSync(join(dir, "src/billing"), { recursive: true });
    writeFileSync(join(dir, "src/billing/invoice.ts"), "a\nb\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "init");
    return dir;
  }

  // Why: review printed `guard: blocked (1 findings)` and never said why.
  it("prints each guard finding's message", async () => {
    const dir = await reviewRepo();
    sati(dir, "feature", "create", "Billing", "--status", "shipped", "--paths", "src/billing/**");
    const feature = satiJson<Rec[]>(dir, "feature", "list").data[0] as Rec;
    expect(sati(dir, "feature", "update", feature.id, "--protected").code).toBe(0);
    git(dir, "checkout", "-qb", "feat");
    git(dir, "rm", "-q", "src/billing/invoice.ts");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "drop"], {
      cwd: dir,
      env: { ...process.env, SATI_GUARD: "off" },
      stdio: "ignore",
    });
    const r = sati(dir, "review", "main...HEAD");
    expect(r.stdout).toContain("guard: blocked");
    expect(r.stdout).toMatch(/- blocked: .*src\/billing\/invoice\.ts/u);
  });

  // Why: review listed the 20 oldest decisions whatever the range, and counted `.sati/` files,
  // which change with every write, as code under review.
  it("lists only decisions from the range or its features, and leaves out .sati/", async () => {
    const dir = await reviewRepo();
    const old = satiJson<Rec>(dir, "decision", "record", "Old choice", "--decision", "x").data;
    // Commit times have one-second precision: make sure the range starts after the old one.
    await new Promise((r) => setTimeout(r, 1100));
    git(dir, "commit", "-q", "--allow-empty", "-m", "base");
    git(dir, "checkout", "-qb", "feat");
    const fresh = satiJson<Rec>(dir, "decision", "record", "New choice", "--decision", "y").data;
    mkdirSync(join(dir, ".sati"), { recursive: true });
    writeFileSync(join(dir, ".sati", "x.json"), "{}\n");
    writeFileSync(join(dir, "src/billing/tax.ts"), "t\n");
    git(dir, "add", "-f", ".");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "work"], {
      cwd: dir,
      env: { ...process.env, SATI_GUARD: "off" },
      stdio: "ignore",
    });
    const r = satiJson<{ paths: string[]; decisions: { id: string }[] }>(
      dir,
      "review",
      "main...HEAD",
    );
    expect(r.data.paths).toEqual(["src/billing/tax.ts"]);
    const ids = r.data.decisions.map((d) => d.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(old.id);
  });
});

describe("small", () => {
  // Why: the board's API description claimed version 0.0.0 whatever was installed.
  it("the board's OpenAPI document has the CLI version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-ui-"));
    const store = await SqliteStore.open(join(dir, "sati.db"));
    const { project, actor } = await initProject(
      { store, clock: systemClock, ids: createIdFactory() },
      { slug: "ui", name: "UI" },
      { name: "tester", kind: "human" },
    );
    const ctx = {
      store,
      clock: systemClock,
      ids: createIdFactory(),
      projectId: project.id,
      actorId: actor.id,
      branch: "main",
    };
    const token = sessionToken();
    const app = createUiApp({ ctx }, token, dir);
    const session = await app.request(`http://127.0.0.1/session?token=${token}`);
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await app.request("http://127.0.0.1/api/openapi.json", { headers: { cookie } });
    const doc = (await res.json()) as { info: { version: string } };
    expect(doc.info.version).toBe(pkg.version);
    await store.close();
  });

  // Why: two `sati serve` started together both saw no socket; the loser crashed with an
  // unhandled EADDRINUSE (exit 1) instead of exiting 4 with "already running".
  it("of two serves started at once, one runs and the other exits 4", async () => {
    const dir = await tempRepo({ init: true });
    const start = () =>
      spawn(process.execPath, [bin, "serve"], {
        cwd: dir,
        env: { ...process.env, SATI_ACTOR: "tester" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    const servers = [start(), start()];
    try {
      const exits = await Promise.race([
        Promise.any(
          servers.map(
            (c) =>
              new Promise<{ code: number | null; err: string }>((resolve) => {
                let err = "";
                c.stderr.on("data", (d: Buffer) => {
                  err += d.toString();
                });
                c.once("exit", (code) => resolve({ code, err }));
              }),
          ),
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no exit")), 15_000)),
      ]);
      expect(exits.code).toBe(4);
      expect(exits.err).toContain("already running");
      expect(servers.filter((c) => c.exitCode === null)).toHaveLength(1);
    } finally {
      for (const c of servers) c.kill("SIGTERM");
    }
  }, 30_000);

  // Why: the registry kept every deleted temp repo, and `sati projects` opened each one.
  it("projects --prune forgets projects whose folder is gone", () => {
    const home = mkdtempSync(join(tmpdir(), "sati-home-"));
    const kept = mkdtempSync(join(tmpdir(), "sati-kept-"));
    writeFileSync(join(kept, "sati.db"), "");
    const row = (slug: string, root: string) => ({
      slug,
      name: slug,
      projectId: `prj_${slug}`,
      root,
      mode: "git" as const,
      db: join(root, "sati.db"),
    });
    rememberProject(row("kept", kept), home);
    rememberProject(row("gone", join(home, "deleted")), home);
    expect(pruneProjects(home).map((p) => p.slug)).toEqual(["gone"]);
    expect(readProjects(home).map((p) => p.slug)).toEqual(["kept"]);
    const r = run(kept, ["projects", "--prune"], { HOME: home });
    expect(r.stderr).toContain("Forgot 0 projects");
  });

  // Why: about 1,400 temp repos from test runs had piled up in the owner's real registry.
  it("test runs register projects outside the real home", async () => {
    const registry = process.env.SATI_REGISTRY ?? "";
    expect(registry).not.toBe("");
    expect(registry.startsWith(tmpdir())).toBe(true);
    const dir = await tempRepo();
    expect(sati(dir, "init", "--yes", "--tools", "").code).toBe(0);
    expect(existsSync(registry)).toBe(true);
    const roots = (JSON.parse(readFileSync(registry, "utf8")) as { root: string }[]).map(
      (p) => p.root,
    );
    expect(roots).toContain(dir);
  });
});
