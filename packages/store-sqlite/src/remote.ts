import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import {
  CLI_NAME,
  ERROR_EXIT_CODES,
  type ErrorCode,
  SatiError,
  type StorageAdapter,
  type StorageReader,
  type StorageWriter,
} from "@sati/core";

/**
 * The wire protocol's version. A client and a `sati serve` from different builds may disagree on
 * what a call's arguments mean (a daemon that ignores a paging cursor answers the same page
 * forever), so each `begin` carries it and the daemon echoes it; a mismatch on either side fails.
 */
export const PROTOCOL = 2;

interface Message {
  id: number;
  protocol?: number;
  op: "begin" | "call" | "end" | "abort";
  mode?: "read" | "write";
  txn?: number;
  method?: string;
  args?: unknown[];
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string; hint?: string | null; details?: unknown };
}

function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Largest frame either side accepts. A bigger length prefix is treated as garbage. */
const MAX_FRAME = 16 * 1024 * 1024;

/** Splits the stream into frames. Bad input destroys the socket instead of throwing. */
function decode(socket: Socket, onMessage: (msg: Message) => void): void {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        socket.destroy();
        return;
      }
      if (buf.length < 4 + len) return;
      let msg: Message;
      try {
        msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as Message;
      } catch {
        socket.destroy();
        return;
      }
      buf = buf.subarray(4 + len);
      if (msg === null || typeof msg !== "object") {
        socket.destroy();
        return;
      }
      onMessage(msg);
    }
  });
}

function fail(error: Message["error"]): Error {
  const code = error?.code;
  if (code && code in ERROR_EXIT_CODES) {
    return new SatiError(code as ErrorCode, error?.message ?? code, {
      ...(error?.hint ? { hint: error.hint } : {}),
      ...(error?.details !== undefined ? { details: error.details } : {}),
    });
  }
  return new Error(error?.message ?? "The database daemon failed.");
}

/**
 * Where `sati serve` listens for a database. Windows has no Unix sockets in the file system, so
 * there it is a named pipe keyed by a hash of the database path.
 */
export function socketPath(dbPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return join(dirname(dbPath), "sati.sock");
  const key = createHash("sha256").update(dbPath.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\sati-${key}`;
}

/**
 * The only methods a client may call on its transaction. A plain lookup like `access?.[method]`
 * would also resolve `constructor`, `toString` and the rest of the prototype chain.
 */
const METHODS: ReadonlySet<string> = new Set([
  "getProject",
  "get",
  "findBySuffix",
  "list",
  "readyTasks",
  "getByKey",
  "search",
  "listActivity",
  "getActivity",
  "insert",
  "update",
  "appendActivity",
]);

/** How long a transaction may sit idle before the daemon rolls it back and drops the client. */
const TXN_IDLE_MS = 30_000;

/** One process owns the SQLite file. Others send storage calls over this socket. */
export function listenStore(
  store: StorageAdapter,
  socketPath: string,
  opts: { txnIdleMs?: number } = {},
): Server {
  const idleMs = opts.txnIdleMs ?? TXN_IDLE_MS;
  const server = createServer((socket) => {
    const sessions = new Map<number, StorageReader>();
    const gates = new Map<
      number,
      { resolve: () => void; reject: (err: Error) => void; endId: number }
    >();
    const send = (msg: unknown) => {
      if (!socket.destroyed) socket.write(encode(msg));
    };
    let closed = false;
    // A client that begins and then goes quiet would hold the write lock for everyone. Each
    // message on a transaction restarts its timer; when it fires the socket is destroyed, which
    // rejects the gate and rolls the transaction back.
    const timers = new Map<number, NodeJS.Timeout>();
    const touch = (txn: number) => {
      clearTimeout(timers.get(txn));
      timers.set(
        txn,
        setTimeout(() => socket.destroy(), idleMs),
      );
    };
    const stopTimer = (txn: number) => {
      clearTimeout(timers.get(txn));
      timers.delete(txn);
    };
    // A client that dies mid-transaction must not keep the write lock: rejecting the gate makes
    // `store.write` ROLLBACK and frees the queue for everyone else.
    const onGone = () => {
      closed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const gate of gates.values()) gate.reject(new Error("client disconnected"));
    };
    socket.on("error", onGone);
    socket.on("close", onGone);
    decode(socket, (msg) => {
      if (msg.op === "begin" && msg.txn !== undefined) {
        if (msg.protocol !== PROTOCOL) {
          send({
            id: msg.id,
            ok: false,
            error: {
              code: "CONFLICT",
              message: `This ${CLI_NAME} is a different version from the running \`${CLI_NAME} serve\`.`,
              hint: `Stop \`${CLI_NAME} serve\` and start it again with this version.`,
            },
          });
          return;
        }
        const run = msg.mode === "write" ? store.write.bind(store) : store.read.bind(store);
        let started = false;
        void run(async (access) => {
          // The client may have gone while this call waited in the queue.
          if (closed) throw new Error("client disconnected");
          started = true;
          sessions.set(msg.txn ?? 0, access);
          send({ id: msg.id, ok: true, result: { protocol: PROTOCOL } });
          await new Promise<void>((resolve, reject) => {
            gates.set(msg.txn ?? 0, { resolve, reject, endId: 0 });
            touch(msg.txn ?? 0);
          });
        }).then(
          () => {
            const gate = gates.get(msg.txn ?? 0);
            if (gate) send({ id: gate.endId, ok: true });
            stopTimer(msg.txn ?? 0);
            gates.delete(msg.txn ?? 0);
            sessions.delete(msg.txn ?? 0);
          },
          (err: unknown) => {
            const gate = gates.get(msg.txn ?? 0);
            const error =
              err instanceof SatiError
                ? {
                    code: err.code,
                    message: err.message,
                    hint: err.hint ?? null,
                    details: err.details,
                  }
                : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
            // Failed before `fn` ran (schema too new, busy): the client is still waiting on `begin`.
            if (!started) send({ id: msg.id, ok: false, error });
            else if (gate) send({ id: gate.endId || msg.id, ok: false, error });
            stopTimer(msg.txn ?? 0);
            gates.delete(msg.txn ?? 0);
            sessions.delete(msg.txn ?? 0);
          },
        );
        return;
      }
      if (msg.txn !== undefined && sessions.has(msg.txn)) touch(msg.txn);
      if (msg.op === "call" && msg.txn !== undefined && msg.method) {
        const access = sessions.get(msg.txn) as StorageWriter | undefined;
        const fn = METHODS.has(msg.method)
          ? access?.[msg.method as keyof StorageWriter]
          : undefined;
        if (!access || typeof fn !== "function") {
          send({
            id: msg.id,
            ok: false,
            error: { code: "INTERNAL", message: "No open transaction." },
          });
          return;
        }
        const call = fn as (...args: unknown[]) => Promise<unknown>;
        void call(...(msg.args ?? [])).then(
          (result) => send({ id: msg.id, ok: true, result }),
          (err: unknown) =>
            send({
              id: msg.id,
              ok: false,
              error:
                err instanceof SatiError
                  ? {
                      code: err.code,
                      message: err.message,
                      hint: err.hint ?? null,
                      details: err.details,
                    }
                  : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) },
            }),
        );
        return;
      }
      const gate = msg.txn !== undefined ? gates.get(msg.txn) : undefined;
      if (!gate) return;
      gate.endId = msg.id;
      if (msg.op === "abort") gate.reject(new Error("aborted"));
      else gate.resolve();
    });
  });
  server.listen(socketPath);
  return server;
}

export function connectStore(socketPath: string): StorageAdapter {
  const socket = createConnection(socketPath);
  let seq = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const failAll = (reason: string) => {
    const err = new SatiError("INTERNAL", `Lost the connection to the sati daemon (${reason}).`, {
      hint: "Restart `sati serve` and retry.",
    });
    for (const wait of pending.values()) wait.reject(err);
    pending.clear();
  };
  let down: string | undefined;
  socket.on("error", (err) => {
    down ??= err.message;
    failAll(err.message);
  });
  socket.on("close", () => {
    down ??= "connection closed";
    failAll(down);
  });
  decode(socket, (msg) => {
    const wait = pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    if (msg.ok) wait.resolve(msg.result);
    else wait.reject(fail(msg.error));
  });
  const request = <T = unknown>(msg: Omit<Message, "id">) =>
    new Promise<T>((resolve, reject) => {
      const id = ++seq;
      if (down !== undefined) {
        reject(new SatiError("INTERNAL", `Lost the connection to the sati daemon (${down}).`));
        return;
      }
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      socket.write(encode({ ...msg, id }));
    });
  const proxy = (txn: number): StorageWriter =>
    new Proxy({} as StorageWriter, {
      get:
        (_t, method) =>
        (...args: unknown[]) =>
          request({ op: "call", txn, method: String(method), args }),
    });
  const run = async <T>(
    mode: "read" | "write",
    fn: (access: StorageWriter) => Promise<T>,
  ): Promise<T> => {
    const txn = ++seq;
    const ack = await request<{ protocol?: number } | undefined>({
      op: "begin",
      mode,
      txn,
      protocol: PROTOCOL,
    });
    if (ack?.protocol !== PROTOCOL) {
      // A daemon from an older build: it opened the transaction, so close it before refusing.
      await request({ op: "abort", txn }).catch(() => undefined);
      throw new SatiError("CONFLICT", `The running \`${CLI_NAME} serve\` is a different version.`, {
        hint: `Stop \`${CLI_NAME} serve\` and start it again with this version.`,
      });
    }
    try {
      const result = await fn(proxy(txn));
      await request({ op: "end", txn });
      return result;
    } catch (err) {
      await request({ op: "abort", txn }).catch(() => undefined);
      throw err;
    }
  };
  return {
    read: <T>(fn: (r: StorageReader) => Promise<T>) =>
      run("read", fn as (access: StorageWriter) => Promise<T>),
    write: <T>(fn: (w: StorageWriter) => Promise<T>) => run("write", fn),
    close: async () => {
      socket.end();
    },
  };
}
