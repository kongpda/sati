import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory, createTask, initProject, systemClock } from "@sati/core";
import { describe, expect, it } from "vitest";
import { classifyFilesystem } from "../src/fs-kind.js";
import { connectStore, listenStore } from "../src/remote.js";
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

describe("daemon socket", () => {
  it("serves a write from another connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-sock-"));
    const db = join(dir, "sati.db");
    const sock = join(dir, "sati.sock");
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
