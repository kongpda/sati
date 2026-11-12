import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createIdFactory,
  initProject,
  recordDecision,
  SEARCHABLE,
  type StorageAdapter,
  type StorageReader,
  systemClock,
  TASK_STATUSES,
} from "@sati/core";
import { SqliteStore } from "@sati/store-sqlite";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { rangeDecisions } from "../src/commands/review.js";
import { pruneProjects, readProjects, rememberProject } from "../src/projects.js";
import { readStdin } from "../src/runtime/input.js";
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

describe("repeatable flags", () => {
  // Why: citty keeps the last value of a repeated flag, so `--label a --label b` silently kept
  // only b. A list flag must take every value; any other flag must still refuse the repeat,
  // and a name given together with its alias is the same mistake in disguise.
  it("--label twice adds both labels, and a flag that is not repeatable still refuses a repeat", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Rec>(dir, "task", "create", "A", "--label", "ui", "--label", "db").data;
    expect(t.labels).toEqual(["ui", "db"]);
    const u = satiJson<Rec>(dir, "task", "update", t.id, "--labels=x", "--labels", "y,z").data;
    expect(u.labels).toEqual(["x", "y", "z"]);
    const own = satiJson<Rec>(dir, "task", "create", "B", "--label", "only").data;
    expect(own.labels).toEqual(["only"]);

    const twice = sati(dir, "task", "create", "C", "--priority", "high", "--priority", "low");
    expect(twice.code).toBe(2);
    expect(twice.stderr).toContain("--priority was given twice");

    const both = sati(dir, "task", "create", "D", "--label", "a", "--labels", "b");
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("same option");
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

  // Review 7.5: the help listed statuses in one order and the error in another.
  it("task list help lists the statuses in the order the error does", async () => {
    const dir = await tempRepo({ init: true });
    const help = run(dir, ["task", "list", "--help"]).stdout.replace(/\s+/gu, " ");
    expect(help).toContain(TASK_STATUSES.join(", "));
    expect(run(dir, ["task", "list", "--status", "nope"]).stderr).toContain(
      TASK_STATUSES.join(", "),
    );
  });

  // Review 7.10: `doctor --reviewed <id>` is the one documented way; the update flags still work
  // for old scripts but are not offered.
  it("hides --reviewed on update, and the flag still clears needsReview", async () => {
    const dir = await tempRepo({ init: true });
    for (const kind of ["task", "feature", "note"]) {
      expect(run(dir, [kind, "update", "--help"]).stdout).not.toContain("--reviewed");
    }
    const t = satiJson<{ id: string }>(dir, "task", "create", "T").data;
    expect(sati(dir, "task", "update", t.id, "--reviewed").code).toBe(0);
  });
});

describe("feature list --md", () => {
  // Review 7.9: `--format` had one value, so it is a plain switch now; `--format md` stays hidden.
  it("feature list --md prints the shipped-features Markdown", async () => {
    const dir = await tempRepo({ init: true });
    const f = satiJson<{ id: string }>(dir, "feature", "create", "Login").data;
    for (const status of ["building", "shipped"]) {
      expect(sati(dir, "feature", "update", f.id, "--status", status).code).toBe(0);
    }
    const md = sati(dir, "feature", "list", "--md");
    expect(md.code).toBe(0);
    expect(md.stdout).toContain("Login");
    expect(md.stdout).toMatch(/^#/mu);
    expect(sati(dir, "feature", "list", "--format", "md").stdout).toBe(md.stdout);
    const help = run(dir, ["feature", "list", "--help"]).stdout;
    expect(help).toContain("--md");
    expect(help).not.toContain("--format");
  });
});

describe("task checklist", () => {
  // Review 7.7: show, complete and release default to the task you hold; checklist did not.
  it("checklist ticks a step of the task you hold when no id is given", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<{ id: string }>(dir, "task", "create", "Steps").data;
    expect(sati(dir, "task", "checklist", t.id, "--add", "one").code).toBe(0);
    expect(sati(dir, "task", "claim", t.id).code).toBe(0);
    expect(sati(dir, "task", "checklist", "--done", "1").code).toBe(0);
    const after = satiJson<{ checklist: { done: boolean }[] }>(dir, "task", "show", t.id).data;
    expect(after.checklist[0]?.done).toBe(true);
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

  // Why: review ran the guard without the project's `maxRemovalRatio`, so it called a change
  // blocked that `guard` and the pre-push hook let through.
  it("gives the verdict guard gives, with the project's removal ratio", async () => {
    const dir = await reviewRepo();
    writeFileSync(join(dir, "src/billing/invoice.ts"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    sati(dir, "feature", "create", "Billing", "--status", "shipped", "--paths", "src/billing/**");
    const feature = satiJson<(Rec & { projectId: string })[]>(dir, "feature", "list").data[0];
    if (!feature) throw new Error("no feature");
    expect(sati(dir, "feature", "update", feature.id, "--protected").code).toBe(0);
    mkdirSync(join(dir, ".sati"), { recursive: true });
    writeFileSync(
      join(dir, ".sati", "sati.config.json"),
      JSON.stringify({
        version: 1,
        projectId: feature.projectId,
        mode: "git",
        guard: { maxRemovalRatio: 0.95 },
      }),
    );
    git(dir, "add", "-f", ".");
    git(dir, "commit", "-qm", "ten lines");
    git(dir, "checkout", "-qb", "feat");
    writeFileSync(join(dir, "src/billing/invoice.ts"), "1\n2\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "trim"], {
      cwd: dir,
      env: { ...process.env, SATI_GUARD: "off" },
      stdio: "ignore",
    });
    const guard = satiJson<{ verdict: string }>(dir, "guard", "--range", "main...HEAD").data;
    const review = satiJson<{ guard: { verdict: string } }>(dir, "review", "main...HEAD").data;
    expect(guard.verdict).not.toBe("blocked");
    expect(review.guard.verdict).toBe(guard.verdict);
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

  // Review 11.12: review read every decision the project ever made to find the few in range.
  it("review reads only decisions inside the range", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-review-"));
    const store = await SqliteStore.open(join(dir, "sati.db"));
    let now = new Date("2026-01-01T00:00:00.000Z");
    const clock = { now: () => now };
    const ids = createIdFactory();
    const { project, actor } = await initProject(
      { store, clock, ids },
      { slug: "review", name: "Review" },
      { name: "tester", kind: "human" },
    );
    const base = { clock, ids, projectId: project.id, actorId: actor.id, branch: "main" };
    const ctx = { ...base, store };
    const old = await recordDecision(ctx, { title: "Old", decision: "x" });
    now = new Date("2026-06-01T00:00:00.000Z");
    const fresh = await recordDecision(ctx, { title: "Fresh", decision: "y" });
    const read: string[] = [];
    const wrap = <R extends StorageReader>(r: R): R => ({
      ...r,
      list: async (...args: Parameters<StorageReader["list"]>) => {
        const rows = await r.list(...args);
        read.push(...rows.map((x) => x.id));
        return rows;
      },
    });
    const counting: StorageAdapter = {
      read: (fn) => store.read((r) => fn(wrap(r))),
      write: (fn) => store.write(fn),
      close: () => store.close(),
    };
    const found = await rangeDecisions(
      { ...base, store: counting },
      "2026-05-01T00:00:00.000Z",
      new Set(),
    );
    expect(found.map((d) => d.id)).toEqual([fresh.id]);
    expect(read).not.toContain(old.id);
    await store.close();
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

  // Why: `init` reads the list, adds one entry and writes it back. Run in two repos at once,
  // the second write dropped the first project from `sati projects`.
  it("keeps every project when several are registered at the same time", async () => {
    const home = mkdtempSync(join(tmpdir(), "sati-home-"));
    const repos = await Promise.all(Array.from({ length: 6 }, () => tempRepo()));
    const codes = await Promise.all(
      repos.map(
        (cwd) =>
          new Promise<number | null>((done) => {
            const child = spawn(process.execPath, [bin, "init", "--yes", "--tools", ""], {
              cwd,
              env: { ...process.env, HOME: home, USERPROFILE: home, SATI_REGISTRY: "" },
              stdio: "ignore",
            });
            child.on("close", done);
          }),
      ),
    );
    expect(codes).toEqual([0, 0, 0, 0, 0, 0]);
    expect(
      readProjects(home)
        .map((p) => p.root)
        .sort(),
    ).toEqual([...repos].sort());
  }, 30_000);

  // Why: a process killed while it held the lock must not block every later `init`.
  it("takes over a registry lock left by a dead process", () => {
    const home = mkdtempSync(join(tmpdir(), "sati-home-"));
    const lock = join(home, ".sati", "projects.json.lock");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const root = mkdtempSync(join(tmpdir(), "sati-kept-"));
    rememberProject(
      { slug: "a", name: "a", projectId: "prj_a", root, mode: "git", db: join(root, "sati.db") },
      home,
    );
    expect(readProjects(home).map((p) => p.slug)).toEqual(["a"]);
    expect(existsSync(lock)).toBe(false);
  });

  // Why: `projects` opened each database for writing, which created an empty one where it was
  // missing. The listing then showed zero tasks instead of a problem, and `--prune` kept it.
  it("projects does not create a database for a project whose database is gone", () => {
    const home = mkdtempSync(join(tmpdir(), "sati-home-"));
    const root = mkdtempSync(join(tmpdir(), "sati-ghost-"));
    const db = join(root, "sati.db");
    rememberProject(
      { slug: "ghost", name: "ghost", projectId: "prj_ghost", root, mode: "git", db },
      home,
    );
    const r = run(root, ["projects"], { HOME: home });
    // A count of -1 told a person nothing: the line names the cause and the way out.
    expect(r.stdout).toContain("ghost  database not readable, `sati projects --prune` forgets it");
    expect(r.stdout).not.toContain("ready -1");
    expect(existsSync(db)).toBe(false);
  });

  // Why: a project moved or given up stayed in `sati projects` for ever. Forgetting it must
  // never take the folder or the database with it, and must not happen by accident.
  it("projects forget removes only the registry entry", () => {
    const home = mkdtempSync(join(tmpdir(), "sati-home-"));
    const row = (slug: string) => {
      const root = mkdtempSync(join(tmpdir(), `sati-${slug}-`));
      writeFileSync(join(root, "sati.db"), "");
      return {
        slug,
        name: slug,
        projectId: `prj_${slug}`,
        root,
        mode: "git" as const,
        db: join(root, "sati.db"),
      };
    };
    const a = row("a");
    const b = row("b");
    rememberProject(a, home);
    rememberProject(b, home);
    const unasked = run(a.root, ["projects", "forget", "a"], { HOME: home });
    expect(unasked.code).toBe(2);
    expect(readProjects(home).map((p) => p.slug)).toEqual(["a", "b"]);

    const bySlug = run(a.root, ["projects", "forget", "a", "--yes"], { HOME: home });
    expect(bySlug.code).toBe(0);
    expect(bySlug.stdout).toContain("Forgot a.");
    // The list command must not run after the subcommand.
    expect(bySlug.stdout).not.toContain("ready ");
    expect(readProjects(home).map((p) => p.slug)).toEqual(["b"]);
    expect(existsSync(a.root)).toBe(true);
    expect(existsSync(a.db)).toBe(true);

    const byPath = run(a.root, ["projects", "forget", b.root, "--yes"], { HOME: home });
    expect(byPath.code).toBe(0);
    expect(readProjects(home)).toEqual([]);
    expect(existsSync(b.db)).toBe(true);
    expect(run(a.root, ["projects", "forget", "nope", "--yes"], { HOME: home }).code).toBe(3);
  });

  // Why: the name shows on the board for everyone, so an agent may not change it.
  it("settings --name renames the project and only a person may", async () => {
    const dir = await tempRepo({ init: true });
    const agent = run(dir, ["settings", "--name", "Agent pick"], {
      SATI_ACTOR: "",
      CLAUDECODE: "1",
    });
    expect(agent.code).toBe(8);
    expect(agent.stderr).toContain("Only a person can rename the project");
    expect(satiJson<{ name: string }>(dir, "settings").data.name).toBe("Demo");

    const renamed = satiJson<{ name: string; review: string }>(
      dir,
      "settings",
      "--name",
      "New name",
    );
    expect(renamed.code).toBe(0);
    expect(renamed.data).toMatchObject({ name: "New name", review: "agents" });
    expect(satiJson<{ name: string }>(dir, "settings").data.name).toBe("New name");
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

describe("milestone flags", () => {
  // Why: `task update --due none` clears a date, but `milestone update` passed "none" on as a day
  // and failed, so a milestone's target date could be set but never removed.
  it("milestone update --date none clears the target date", async () => {
    const dir = await tempRepo({ init: true });
    const m = satiJson<{ id: string }>(
      dir,
      "milestone",
      "create",
      "M",
      "--date",
      "2026-12-01",
    ).data;
    const cleared = satiJson<{ targetDate: string | null }>(
      dir,
      "milestone",
      "update",
      m.id,
      "--date",
      "none",
    ).data;
    expect(cleared.targetDate).toBeNull();
  });
});

// Review 7.1: one flag per idea. Each old spelling is a hidden alias, so scripts keep working.
describe("flag renames keep the old name working", () => {
  interface Row {
    id: string;
    assigneeIds?: string[];
    targetDate?: string | null;
    featureIds?: string[];
    checklist?: { done: boolean }[];
    approvedCommit?: string | null;
    status?: string;
  }

  it("--assignee is the flag, --assign still works, and help names only the new one", async () => {
    const dir = await tempRepo({ init: true });
    for (const flag of ["--assignee", "--assign"]) {
      const t = satiJson<Row>(dir, "task", "create", `For ${flag}`, flag, "me").data;
      expect(t.assigneeIds, flag).toHaveLength(1);
    }
    const help = sati(dir, "task", "create", "--help").stdout;
    expect(help).toContain("--assignee");
    expect(help).not.toMatch(/--assign\b(?!ee)/u);
  });

  it("--due is the milestone and template flag, --date still works", async () => {
    const dir = await tempRepo({ init: true });
    for (const flag of ["--due", "--date"]) {
      const m = satiJson<Row>(dir, "milestone", "create", `M ${flag}`, flag, "2027-01-31").data;
      expect(m.targetDate, flag).toBe("2027-01-31");
      const moved = satiJson<Row>(dir, "milestone", "update", m.id, flag, "2027-02-01").data;
      expect(moved.targetDate, flag).toBe("2027-02-01");
    }
    const dry = (flag: string) =>
      sati(dir, "plan", "apply", "campaign", flag, "2027-01-31", "--dry-run").stdout;
    expect(dry("--due")).toBe(dry("--date"));
    expect(dry("--due")).toContain("2027");
    expect(sati(dir, "milestone", "create", "--help").stdout).not.toContain("--date");
    // A bad day names the flag the person was shown.
    expect(sati(dir, "milestone", "create", "M", "--due", "2026-13-45").stderr).toContain("--due:");
  });

  it("--commit is the approving flag on task update, --approved-commit still works", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Row>(dir, "task", "create", "Review me").data;
    expect(sati(dir, "task", "claim", t.id).code).toBe(0);
    // Both spellings reach the same check: a commit that is not the branch head is refused.
    for (const flag of ["--commit", "--approved-commit"]) {
      const r = run(dir, ["task", "update", t.id, "--status", "done", flag, "abc1234"]);
      expect(r.stderr, flag).not.toContain("Unknown option");
    }
    expect(sati(dir, "task", "update", "--help").stdout).not.toContain("--approved-commit");
  });

  it("--feature is repeatable on decision record, --features still works", async () => {
    const dir = await tempRepo({ init: true });
    const a = satiJson<Row>(dir, "feature", "create", "A").data;
    const b = satiJson<Row>(dir, "feature", "create", "B").data;
    const record = (...flags: string[]) =>
      satiJson<Row>(dir, "decision", "record", "Why", "--decision", "because", ...flags).data;
    expect(record("--feature", a.id, "--feature", b.id).featureIds?.sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(record("--features", `${a.id},${b.id}`).featureIds?.sort()).toEqual([a.id, b.id].sort());
    const help = sati(dir, "decision", "record", "--help").stdout;
    expect(help).toContain("--feature");
    expect(help).not.toContain("--features");
  });

  it("--tick and --untick are the checklist flags, --done and --undone still work", async () => {
    const dir = await tempRepo({ init: true });
    const t = satiJson<Row>(dir, "task", "create", "Steps").data;
    expect(sati(dir, "task", "checklist", t.id, "--add", "one").code).toBe(0);
    const done = () => satiJson<Row>(dir, "task", "show", t.id).data.checklist?.map((i) => i.done);
    for (const [on, off] of [
      ["--tick", "--untick"],
      ["--done", "--undone"],
    ] as const) {
      expect(sati(dir, "task", "checklist", t.id, on, "1").code, on).toBe(0);
      expect(done()).toEqual([true]);
      expect(sati(dir, "task", "checklist", t.id, off, "1").code, off).toBe(0);
      expect(done()).toEqual([false]);
    }
    const help = sati(dir, "task", "checklist", "--help").stdout;
    expect(help).toContain("--tick");
    expect(help).not.toContain("--done");
  });
});
