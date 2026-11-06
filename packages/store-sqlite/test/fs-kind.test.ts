import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory, createTask, initProject, systemClock } from "@sati/core";
import { describe, expect, it } from "vitest";
import { classifyFilesystem } from "../src/fs-kind.js";
import { connectStore, listenStore, socketPath } from "../src/remote.js";
import { SqliteStore } from "../src/store.js";

describe("filesystem class", () => {
  it("treats nfs, smb and 9p as unsafe and apfs as local", () => {
    expect(classifyFilesystem("apfs")).toBe("local");
    expect(classifyFilesystem("ext4")).toBe("local");
    expect(classifyFilesystem("nfs")).toBe("network");
    expect(classifyFilesystem("smbfs")).toBe("network");
    expect(classifyFilesystem("9p")).toBe("bind");
  });
});

describe("socket path", () => {
  // PLAN: `sati serve` must work on Windows, which cannot listen on a socket file in a folder.
  it("uses a named pipe on Windows and a socket file next to the database elsewhere", () => {
    expect(socketPath("/repo/.git/sati/sati.db", "linux")).toBe(
      join("/repo/.git/sati", "sati.sock"),
    );
    const pipe = socketPath("C:\\repo\\.git\\sati\\sati.db", "win32");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\sati-[0-9a-f]{16}$/u);
    // One pipe per database, whatever the case of the drive path.
    expect(socketPath("c:\\REPO\\.git\\sati\\sati.db", "win32")).toBe(pipe);
    expect(socketPath("C:\\other\\.git\\sati\\sati.db", "win32")).not.toBe(pipe);
  });
});

describe("daemon socket", () => {
  it("serves a write from another connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-sock-"));
    const db = join(dir, "sati.db");
    const sock = socketPath(db);
    const owner = await SqliteStore.open(db);
    const server = listenStore(owner, sock);
    await new Promise((resolve) => server.once("listening", resolve));
    const remote = connectStore(sock);
    const { project, actor } = await initProject(
      { store: remote, clock: systemClock, ids: createIdFactory() },
      { slug: "sock", name: "Sock" },
      { name: "daemon@test", kind: "human" },
    );
    const ctx = {
      store: remote,
      clock: systemClock,
      ids: createIdFactory(),
      projectId: project.id,
      actorId: actor.id,
      branch: null,
    };
    const task = await createTask(ctx, { title: "Through the socket" });
    const seen = await owner.read((r) => r.get("task", task.id));
    expect(seen?.title).toBe("Through the socket");
    await remote.close();
    server.close();
    await owner.close();
  });
});
