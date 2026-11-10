import { mkdtempSync, statSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SatiError } from "@sati/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, SqliteStore } from "../src/index.js";
import { connectStore, listenStore, PROTOCOL, socketPath } from "../src/remote.js";
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
    client.write(frame({ id: 1, op: "begin", mode: "write", txn: 1, protocol: PROTOCOL }));
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
  // A client from another build may read call arguments differently; it must be refused.
  it("refuses a begin without this protocol version", async () => {
    const client = await connect();
    client.write(frame({ id: 3, op: "begin", mode: "read", txn: 3 }));
    expect(await within(nextFrame(client))).toMatchObject({
      id: 3,
      ok: false,
      error: { code: "CONFLICT" },
    });
    client.destroy();
  });

  it("answers a begin that fails before it starts", async () => {
    owner.db.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    const client = await connect();
    client.write(frame({ id: 7, op: "begin", mode: "write", txn: 7, protocol: PROTOCOL }));
    const reply = await within(nextFrame(client));
    expect(reply).toMatchObject({ id: 7, ok: false, error: { code: "SCHEMA_TOO_NEW" } });
    client.destroy();
  });
});

describe("daemon hardening", () => {
  // `access?.[method]` would resolve `constructor` or `toString` from the prototype chain.
  it("refuses methods that are not on the storage allowlist", async () => {
    const client = await connect();
    client.write(frame({ id: 1, op: "begin", mode: "write", txn: 1, protocol: PROTOCOL }));
    await nextFrame(client);
    for (const [id, method] of [
      [2, "constructor"],
      [3, "toString"],
      [4, "__proto__"],
    ] as const) {
      client.write(frame({ id, op: "call", txn: 1, method, args: [] }));
      expect(await within(nextFrame(client))).toMatchObject({ id, ok: false });
    }
    client.destroy();
  });

  // A client that begins and idles would hold the write lock for every other agent.
  it("rolls back and drops a client that idles inside a transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-remote-"));
    const quick = socketPath(join(dir, "sati.db"));
    const fast = listenStore(owner, quick, { txnIdleMs: 100 });
    await new Promise((resolve) => fast.once("listening", resolve));
    const client = createConnection(quick);
    await new Promise((resolve) => client.once("connect", resolve));
    const gone = closed(client);
    client.write(frame({ id: 1, op: "begin", mode: "write", txn: 1, protocol: PROTOCOL }));
    await nextFrame(client);
    client.write(frame({ id: 2, op: "call", txn: 1, method: "insert", args: ["task", task()] }));
    await nextFrame(client);
    await within(gone);
    await within(owner.write(async () => undefined));
    expect(await owner.read((r) => r.list("task", project().id))).toHaveLength(0);
    fast.close();
  });
});

describe("daemon client", () => {
  // If the daemon dies, callers need an error they can act on, not a promise that never settles.
  it("rejects pending requests with a SatiError when the daemon drops the connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-remote-"));
    // socketPath gives a named pipe on Windows, which cannot listen on a socket file.
    const deaf = socketPath(join(dir, "deaf.db"));
    const silent = createServer((s) => setTimeout(() => s.destroy(), 50));
    await new Promise<void>((resolve) => silent.listen(deaf, resolve));
    const remote = connectStore(deaf);
    const err = await within(remote.read(async () => undefined)).catch((e) => e);
    expect(err).toBeInstanceOf(SatiError);
    expect(err.message).toMatch(/daemon/);
    silent.close();
  });

  // An older daemon opens the transaction but does not echo a protocol: refuse, and abort it.
  it("refuses a daemon from another build and closes the transaction it opened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sati-remote-"));
    const old = socketPath(join(dir, "old.db"));
    const ops: string[] = [];
    const legacy = createServer((s) => {
      let buf = Buffer.alloc(0);
      s.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
          const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString());
          buf = buf.subarray(4 + buf.readUInt32BE(0));
          ops.push(msg.op);
          s.write(frame({ id: msg.id, ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => legacy.listen(old, resolve));
    const remote = connectStore(old);
    const ran: string[] = [];
    const err = await within(remote.read(async () => ran.push("fn"))).catch((e) => e);
    expect(err).toMatchObject({ code: "CONFLICT" });
    expect(ran).toEqual([]);
    expect(ops).toEqual(["begin", "abort"]);
    await remote.close();
    legacy.close();
  });

  it("fails fast when no daemon is listening", async () => {
    const remote = connectStore(
      socketPath(join(mkdtempSync(join(tmpdir(), "sati-remote-")), "none.db")),
    );
    const err = await within(remote.read(async () => undefined)).catch((e) => e);
    expect(err).toBeInstanceOf(SatiError);
  });
});

describe("daemon framing", () => {
  // A large frame that arrives in many small chunks used to be re-copied once per chunk.
  it("receives a 2 MB frame sent in 1 KB chunks intact", async () => {
    const client = await connect();
    client.write(frame({ id: 1, op: "begin", mode: "write", txn: 1, protocol: PROTOCOL }));
    expect((await nextFrame(client)).ok).toBe(true);
    const big = task({ body: "x".repeat(2 * 1024 * 1024) });
    const whole = frame({ id: 2, op: "call", txn: 1, method: "insert", args: ["task", big] });
    const reply = nextFrame(client);
    for (let at = 0; at < whole.length; at += 1024) {
      client.write(whole.subarray(at, at + 1024));
      if (at % (64 * 1024) === 0) await new Promise((r) => setImmediate(r));
    }
    expect(await within(reply)).toMatchObject({ id: 2, ok: true });
    client.write(frame({ id: 3, op: "end", txn: 1 }));
    expect(await within(nextFrame(client))).toMatchObject({ id: 3, ok: true });
    expect((await owner.read((r) => r.get("task", big.id)))?.body).toBe(big.body);
    client.destroy();
  });

  // The reader drops an over-limit frame, so the sender must refuse it and say why; otherwise
  // the caller sees only "connection closed".
  it("refuses an over-limit message on either side with an error that names the limit", async () => {
    const huge = task({ body: "x".repeat(17 * 1024 * 1024) });
    await owner.write((w) => w.insert("task", huge));
    const remote = connectStore(sock);
    const fromDaemon = await within(remote.read((r) => r.get("task", huge.id))).catch((e) => e);
    expect(fromDaemon).toBeInstanceOf(SatiError);
    expect(fromDaemon.message).toMatch(/limit is 16 MB/);
    const toDaemon = await within(
      remote.write((w) => w.insert("task", { ...huge, id: task().id })),
    ).catch((e) => e);
    expect(toDaemon.message).toMatch(/limit is 16 MB/);
    // The connection survives both refusals.
    expect(await within(remote.read((r) => r.getProject()))).toMatchObject({ id: project().id });
    await remote.close();
  });

  // Anyone who can open the socket can read and write every record.
  it.skipIf(process.platform === "win32")("creates the socket readable only by its owner", () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600);
  });
});
