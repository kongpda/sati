import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { socketPath } from "@sati/store-sqlite";
import { describe, expect, it } from "vitest";
import { isLocalInstall } from "../src/install.js";

// Assumptions that only a Windows machine can check. They run on the Windows CI runners and
// are skipped elsewhere; the macOS and Linux paths are covered by the other tests.
describe.runIf(process.platform === "win32")("on Windows", () => {
  // A DB on a network drive is reached through `sati serve`. The CLI picks the server only when
  // `existsSync` sees its named pipe, so a false here would refuse every command.
  it("sees a listening named pipe with existsSync, and not a closed one", async () => {
    const pipe = socketPath(join(tmpdir(), `sati-pipe-${process.pid}.db`));
    expect(existsSync(pipe)).toBe(false);
    const server = createServer();
    await new Promise<void>((done) => server.listen(pipe, done));
    try {
      expect(existsSync(pipe)).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    expect(existsSync(pipe)).toBe(false);
  });

  // The root comes from git and the script from Node; they may disagree on the drive letter's
  // case. A false negative makes init write a global `sati` into the configs of a project install.
  it("matches a project install when the drive letter case differs", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "sati-win-")));
    const dist = join(root, "node_modules", "@kongpda", "sati", "dist");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(root, "node_modules", ".bin"));
    writeFileSync(join(root, "node_modules", ".bin", "sati"), "");
    const script = join(dist, "index.mjs");
    writeFileSync(script, "");
    const flip = (p: string) =>
      `${p[0] === p[0]?.toUpperCase() ? p[0]?.toLowerCase() : p[0]?.toUpperCase()}${p.slice(1)}`;
    expect(isLocalInstall(root, script)).toBe(true);
    expect(isLocalInstall(flip(root), script)).toBe(true);
    expect(isLocalInstall(root, flip(script))).toBe(true);
  });
});
