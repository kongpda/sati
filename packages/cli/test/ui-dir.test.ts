import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { uiDir } from "../src/commands/ui.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("uiDir", () => {
  // PLAN: `npm install -g @kongpda/sati` then `sati ui` must work. The package publishes only
  // `dist`, so the built UI has to live inside it.
  it("ships the built UI inside the published dist folder", () => {
    const dist = fileURLToPath(new URL("../dist", import.meta.url));
    expect(existsSync(join(dist, "ui", "index.html"))).toBe(true);
    expect(uiDir(dist)).toBe(join(dist, "ui"));
  });

  // PLAN Security: the UI page runs with the session cookie. A repo that plants
  // `packages/ui/dist/index.html` must not get its page served when `sati ui` runs inside it.
  it("never serves a page from the working directory", () => {
    const repo = mkdtempSync(join(tmpdir(), "sati-uidir-"));
    const bin = mkdtempSync(join(tmpdir(), "sati-uibin-"));
    dirs.push(repo, bin);
    mkdirSync(join(repo, "packages/ui/dist"), { recursive: true });
    writeFileSync(join(repo, "packages/ui/dist/index.html"), "<script>steal()</script>");
    const cwd = process.cwd();
    process.chdir(repo);
    try {
      expect(() => uiDir(join(bin, "a/b/c"))).toThrow(/not been built/u);
    } finally {
      process.chdir(cwd);
    }
  });
});
