import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdFactory, createTask, initProject, systemClock } from "@sati/core";
import { describe, expect, it } from "vitest";
import { classifyFilesystem, filesystemKind, mountedType, syncedFolder } from "../src/fs-kind.js";
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

  // An NTFS or exFAT disk on Linux mounts as fuseblk. Read as a network share, it refused the
  // database until the user ran `serve`.
  it("treats a FUSE block device as a local disk, other FUSE mounts as network", () => {
    expect(classifyFilesystem("fuseblk")).toBe("local");
    expect(classifyFilesystem("fuse.sshfs")).toBe("network");
  });

  // Office users keep projects in Dropbox or OneDrive. Those folders look like a local disk, and
  // a database copied mid-write there ends up corrupt.
  it("names the file-sync app that keeps a folder", () => {
    expect(syncedFolder("/Users/dara/Dropbox/launch/.git/sati")).toBe("Dropbox");
    expect(syncedFolder("/Users/dara/Library/CloudStorage/OneDrive-Acme/q3")).toBe("OneDrive");
    expect(syncedFolder("/Users/dara/Library/Mobile Documents/com~apple~CloudDocs/x")).toBe(
      "iCloud Drive",
    );
    expect(syncedFolder("C:\\Users\\dara\\OneDrive - Acme\\q3")).toBe("OneDrive");
    expect(syncedFolder("G:\\My Drive\\q3")).toBe("Google Drive");
    expect(syncedFolder("/Users/dara/work/dropbox-clone")).toBeUndefined();
    expect(syncedFolder("/Users/dara/.sati/projects")).toBeUndefined();
  });

  // Windows has no `stat` command, so every path read as local, and a database on a share
  // (\\server\share) ran SQLite WAL over the network without a warning.
  it("treats a UNC path on Windows as network", () => {
    expect(filesystemKind("\\\\server\\share\\repo\\.git\\sati", "win32")).toBe("network");
    expect(filesystemKind("\\\\?\\UNC\\server\\share\\repo", "win32")).toBe("network");
    expect(filesystemKind("C:\\repo\\.git\\sati", "win32")).toBe("local");
    expect(filesystemKind("\\\\?\\C:\\repo\\.git\\sati", "win32")).toBe("local");
  });
});

describe("filesystem type on macOS", () => {
  const mounts = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
    "//me@nas/team on /Volumes/team (smbfs, nodev, nosuid, mounted by me)",
    "nas:/export on /Volumes/team/deep on disk (nfs, nodev)",
  ].join("\n");

  // `stat -f %T` prints a file-type mark there ("/" for a folder), so every disk read as local
  // and a database on a share ran SQLite WAL over the network with no warning.
  it("reads the type of the longest mount point that holds the path", () => {
    expect(mountedType(mounts, "/Users/me/repo/.git/sati")).toBe("apfs");
    expect(mountedType(mounts, "/Volumes/team/repo/.git/sati")).toBe("smbfs");
    expect(mountedType(mounts, "/Volumes/team/deep on disk/repo")).toBe("nfs");
    // A name that only starts like a mount point is not inside it.
    expect(mountedType(mounts, "/Volumes/teammate/repo")).toBe("apfs");
    expect(classifyFilesystem(mountedType(mounts, "/Volumes/team/repo") ?? "")).toBe("network");
  });

  // Runs only on macOS, where the temp folder is known to be on a local disk; the macOS CI cell runs it.
  it.runIf(process.platform === "darwin")("sees the local disk as local", () => {
    expect(filesystemKind(tmpdir())).toBe("local");
  });
});

describe("socket path", () => {
  // Skips on Windows, where the socket is a named pipe and has no path length limit.
  // Reproduced: a database 110 characters deep failed `serve` with a bare "listen EINVAL".
  it.runIf(process.platform !== "win32")("names the limit when the path is too long", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-sock-"));
    const owner = await SqliteStore.open(join(dir, "sati.db"));
    try {
      const long = join(dir, "d".repeat(110), "sati.sock");
      expect(() => listenStore(owner, long)).toThrow(
        expect.objectContaining({ code: "VALIDATION", hint: expect.stringContaining("shorter") }),
      );
    } finally {
      await owner.close();
    }
  });

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
