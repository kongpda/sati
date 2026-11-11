import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "./helpers.js";

const temp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "sati-share-")));

interface Task {
  id: string;
  title: string;
  priority: string;
}

describe("a project shared through a synced folder (ADR 0009)", () => {
  // A team without git has only Dropbox or a file server. When two people change one task before
  // the sync app meets, the app keeps one file and renames the other; losing either edit, or
  // stopping on the renamed file, would make the shared memory worse than a private one.
  it("a second person joins from the folder, and edits made apart are both kept", () => {
    const folder = temp();
    const ann = (...args: string[]) => run(folder, args, { HOME: annHome, SATI_ACTOR: "ann" });
    const bob = (...args: string[]) => run(folder, args, { HOME: bobHome, SATI_ACTOR: "bob" });
    const annHome = temp();
    const bobHome = temp();

    expect(ann("init", "--yes", "--share").code).toBe(0);
    const made = ann("task", "create", "Book the venue", "--json");
    const { id } = JSON.parse(made.stdout) as Task;
    const file = join(folder, ".sati", "tasks", `${id}.json`);

    // The database is never in the folder: a sync app would copy it mid-write.
    expect(readdirSync(join(folder, ".sati")).sort()).toEqual(["sati.config.json", "tasks"]);

    const joined = bob("init", "--yes");
    expect(joined.stdout).toContain("imported  1 record(s)");

    // Both edit the same version. The sync app keeps Bob's file and renames Ann's.
    const before = join(annHome, "before.json");
    const anns = join(annHome, "anns.json");
    copyFileSync(file, before);
    expect(ann("task", "update", id, "--title", "Book hall A").code).toBe(0);
    copyFileSync(file, anns);
    copyFileSync(before, file);
    expect(bob("task", "update", id, "--priority", "high").code).toBe(0);
    copyFileSync(anns, join(folder, ".sati", "tasks", `${id} (ann's conflicted copy).json`));

    // Any command of Bob's loads the copy; no hook or manual import is needed.
    const seen = JSON.parse(bob("task", "show", id, "--json").stdout) as Task;
    expect(seen).toMatchObject({ title: "Book hall A", priority: "high" });
    expect(readdirSync(join(folder, ".sati", "tasks"))).toEqual([`${id}.json`]);

    // The merged record went back to the folder, so Ann gets Bob's edit too.
    const back = JSON.parse(ann("task", "show", id, "--json").stdout) as Task;
    expect(back).toMatchObject({ title: "Book hall A", priority: "high" });
  });
  // A sync app writes files in pieces, and one person's broken file is not the others' fault.
  // Stopping the whole load on it held back every other change in the folder until someone
  // found and fixed that one file.
  it("a half-synced file is left out with a warning, and the other changes still arrive", () => {
    const folder = temp();
    const annHome = temp();
    const bobHome = temp();
    const ann = (...args: string[]) => run(folder, args, { HOME: annHome, SATI_ACTOR: "ann" });
    const bob = (...args: string[]) => run(folder, args, { HOME: bobHome, SATI_ACTOR: "bob" });

    expect(ann("init", "--yes", "--share").code).toBe(0);
    const a = JSON.parse(ann("task", "create", "Book the venue", "--json").stdout) as Task;
    const b = JSON.parse(ann("task", "create", "Print the flyers", "--json").stdout) as Task;
    expect(bob("init", "--yes").code).toBe(0);

    expect(ann("task", "update", a.id, "--title", "Book hall A").code).toBe(0);
    expect(ann("task", "update", b.id, "--title", "Print 200 flyers").code).toBe(0);
    const half = join(folder, ".sati", "tasks", `${b.id}.json`);
    writeFileSync(half, readFileSync(half, "utf8").slice(0, 40));

    const shown = bob("task", "show", a.id, "--json");
    expect(JSON.parse(shown.stdout)).toMatchObject({ title: "Book hall A" });
    expect(shown.stderr).toContain(`tasks/${b.id}.json could not be read`);
    // Bob keeps the version he had, and the file is tried again on every command.
    expect(JSON.parse(bob("task", "show", b.id, "--json").stdout)).toMatchObject({
      title: "Print the flyers",
    });
  });
});
