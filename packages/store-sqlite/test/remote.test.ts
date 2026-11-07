import { mkdtempSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SatiError } from "@sati/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "../src/index.js";
import { connectStore, listenStore, socketPath } from "../src/remote.js";
import { project, task } from "./fixtures.js";

const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};

/** Resolves with the next decoded frame on a raw socket. */
const nextFrame = (socket: Socket) =>
  new Promise<{ id: number; ok: boolean; error?: { code: string } }>((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        socket.off("data", onData);
        resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()));
      }
    };
    socket.on("data", onData);
  });

const closed = (socket: Socket) =>
  new Promise<void>((resolve) => socket.once("close", () => resolve()));

const within = <T>(p: Promise<T>, ms = 3000) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);

let owner: SqliteStore;
let sock: string;
let server: ReturnType<typeof listenStore>;

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-remote-"));
  const db = join(dir, "sati.db");
  sock = socketPath(db);
  owner = await SqliteStore.open(db);
  await owner.write((w) => w.insert("project", project()));
  server = listenStore(owner, sock);
  await new Promise((resolve) => server.once("listening", resolve));
});
afterEach(async () => {
  server.close();
  await owner.close();
});

const connect = async () => {
  const socket = createConnection(sock);
  await new Promise((resolve) => socket.once("connect", resolve));
  return socket;
};

describe("daemon server", () => {
  // A client killed mid-write must not hold the write lock, or every other agent hangs forever.
  it("rolls back and frees the lock when a client dies inside a write", async () => {
    const client = await connect();
    client.write(frame({ id: 1, op: "begin", mode: "write", txn: 1 }));
    expect((await nextFrame(client)).ok).toBe(true);
    client.write(frame({ id: 2, op: "call", txn: 1, method: "insert", args: ["task", task()] }));
    await nextFrame(client);
    client.destroy();
    await within(owner.write(async () => undefined));
    expect(await owner.read((r) => r.list("task", project().id))).toHaveLength(0);
  });

  // Garbage on the socket must cost one connection, not the whole daemon.
  it("drops a client that sends invalid JSON and keeps serving", async () => {
    const bad = await connect();
    const gone = closed(bad);
    const body = Buffer.from("not json");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    bad.write(Buffer.concat([head, body]));
    await within(gone);
    await within(owner.write(async () => undefined));
  });

  // A huge length prefix would otherwise make the daemon buffer forever.
  it("drops a client that announces an oversized frame", async () => {
    const bad = await connect();
    const gone = closed(bad);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(0xffffffff);
    bad.write(head);
    await within(gone);
  });

  // If the transaction cannot start, the client must be told instead of waiting forever.
  it("answers a begin that fails before it starts", async () => {
    owner.db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    const client = await connect();
    client.write(frame({ id: 7, op: "begin", mode: "write", txn: 7 }));
    const reply = await within(nextFrame(client));
    expect(reply).toMatchObject({ id: 7, ok: false, error: { code: "SCHEMA_TOO_NEW" } });
    client.destroy();
  });
});

describe("daemon client", () => {
  // If the daemon dies, callers need an error they can act on, not a promise that never settles.
  it("rejects pending requests with a SatiError when the daemon drops the connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-remote-"));
    const deaf = join(dir, "deaf.sock");
    const silent = createServer((s) => setTimeout(() => s.destroy(), 50));
    await new Promise<void>((resolve) => silent.listen(deaf, resolve));
    const remote = connectStore(deaf);
    const err = await within(remote.read(async () => undefined)).catch((e) => e);
    expect(err).toBeInstanceOf(SatiError);
    expect(err.message).toMatch(/daemon/);
    silent.close();
  });

  it("fails fast when no daemon is listening", async () => {
    const remote = connectStore(join(mkdtempSync(join(tmpdir(), "sati-remote-")), "none.sock"));
    const err = await within(remote.read(async () => undefined)).catch((e) => e);
    expect(err).toBeInstanceOf(SatiError);
  });
});
