import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherFile } from "../src/launcher.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// PLAN 7d: a person with no terminal opens the board by a double click. The file must start the
// board of its own project wherever it is moved, and office folders have spaces and quotes.
describe("launcher file", () => {
  // Skips on Windows, which cannot run the macOS shell launcher it writes; Linux and macOS run it.
  it.runIf(process.platform !== "win32")(
    "starts `ui` in the project folder, whatever the names hold",
    () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "sati-launch-")));
      dirs.push(base);
      const root = join(base, "Dara's Q3 launch");
      mkdirSync(root);
      const script = join(base, "my bin.mjs");
      writeFileSync(script, "console.log(JSON.stringify([process.cwd(), process.argv.slice(2)]))");
      const made = launcherFile("darwin", [process.execPath, script], root, "Q3: Launch");
      expect(made.file).toBe("Q3- Launch board.command");
      expect(made.mode & 0o111).not.toBe(0);
      const file = join(base, made.file);
      writeFileSync(file, made.body, { mode: made.mode });
      // Run from another folder, as Finder does.
      const out = execFileSync(file, { cwd: tmpdir(), encoding: "utf8" });
      expect(JSON.parse(out)).toEqual([root, ["ui"]]);
    },
  );

  it("writes a .cmd on Windows and a desktop entry on Linux", () => {
    const win = launcherFile(
      "win32",
      ["C:\\node\\node.exe", "C:\\s\\sati.mjs"],
      "C:\\My Work",
      "Q3",
    );
    expect(win.file).toBe("Q3 board.cmd");
    expect(win.body).toContain('cd /d "C:\\My Work"\r\n"C:\\node\\node.exe" "C:\\s\\sati.mjs" ui');
    expect(() => launcherFile("win32", ["sati"], "C:\\100%", "Q3")).toThrow(/Windows/u);
    const linux = launcherFile("linux", ["/opt/my $bin/sati"], "/home/dara/Q3 launch", "Q3");
    expect(linux.file).toBe("Q3 board.desktop");
    expect(linux.body).toContain("Path=/home/dara/Q3 launch\n");
    expect(linux.body).toContain('Exec="/opt/my \\$bin/sati" ui\n');
  });
});
