import { createConnection, createServer, type Server, type Socket } from "node:net";
import {
  ERROR_EXIT_CODES,
  type ErrorCode,
  SatiError,
  type StorageAdapter,
  type StorageReader,
  type StorageWriter,
} from "@sati/core";

interface Message {
  id: number;
  op: "begin" | "call" | "end" | "abort";
  mode?: "read" | "write";
  txn?: number;
  method?: string;
  args?: unknown[];
  ok?: boolean;
  result?: unknown;
  error?: { code: string; message: string; hint?: string | null };
}

function encode(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

function decode(socket: Socket, onMessage: (msg: Message) => void): void {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as Message;
      buf = buf.subarray(4 + len);
      onMessage(msg);
    }
  });
}

function fail(error: Message["error"]): Error {
  const code = error?.code;
  if (code && code in ERROR_EXIT_CODES) {
    return new SatiError(code as ErrorCode, error?.message ?? code, {
      ...(error?.hint ? { hint: error.hint } : {}),
    });
  }
  return new Error(error?.message ?? "The database daemon failed.");
}

/** One process owns the SQLite file. Others send storage calls over this socket. */
export function listenStore(store: StorageAdapter, socketPath: string): Server {
  const server = createServer((socket) => {
    const sessions = new Map<number, StorageReader>();
    const gates = new Map<
      number,
      { resolve: () => void; reject: (err: Error) => void; endId: number }
    >();
    const send = (msg: unknown) => socket.write(encode(msg));
    decode(socket, (msg) => {
      if (msg.op === "begin" && msg.txn !== undefined) {
        const run = msg.mode === "write" ? store.write.bind(store) : store.read.bind(store);
        void run(async (access) => {
          sessions.set(msg.txn ?? 0, access);
          send({ id: msg.id, ok: true });
          await new Promise<void>((resolve, reject) => {
            gates.set(msg.txn ?? 0, { resolve, reject, endId: 0 });
          });
        }).then(
          () => {
            const gate = gates.get(msg.txn ?? 0);
            if (gate) send({ id: gate.endId, ok: true });
            gates.delete(msg.txn ?? 0);
            sessions.delete(msg.txn ?? 0);
          },
          (err: unknown) => {
            const gate = gates.get(msg.txn ?? 0);
            const error =
              err instanceof SatiError
                ? { code: err.code, message: err.message, hint: err.hint ?? null }
                : { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) };
            if (gate) send({ id: gate.endId || msg.id, ok: false, error });
            gates.delete(msg.txn ?? 0);
            sessions.delete(msg.txn ?? 0);
          },
        );
        return;
      }
      if (msg.op === "call" && msg.txn !== undefined && msg.method) {
        const access = sessions.get(msg.txn) as StorageWriter | undefined;
        const fn = access?.[msg.method as keyof StorageWriter];
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
                  ? { code: err.code, message: err.message, hint: err.hint ?? null }
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
    await request({ op: "begin", mode, txn });
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
