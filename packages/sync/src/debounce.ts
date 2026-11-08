import type { StorageAdapter, StorageWriter, StoredEntity } from "@sati/core";

/** A record a write inserted or updated. */
export interface WrittenRecord {
  entity: StoredEntity;
  id: string;
}

export interface AfterWrites {
  /** The store to hand to services; its writes schedule `fn`. */
  store: StorageAdapter;
  /** Runs a pending `fn` now, for shutdown. */
  flush(): Promise<void>;
}

/** Passes `w` through, noting each record it inserts or updates. */
function tracking(w: StorageWriter, written: WrittenRecord[]): StorageWriter {
  // A prototype link rather than a spread: the remote adapter's writer is a Proxy with no own keys.
  const tracked: StorageWriter = Object.create(w);
  tracked.insert = (entity, record) => {
    written.push({ entity, id: record.id });
    return w.insert(entity, record);
  };
  tracked.update = (entity, record, expectedVersion) => {
    written.push({ entity, id: record.id });
    return w.update(entity, record, expectedVersion);
  };
  return tracked;
}

/**
 * Wraps a store so `fn` runs `ms` after the last successful write (debounced), with every record
 * the committed writes touched since the last run. Errors from `fn` go to `onError`; they never
 * fail the write that scheduled it, and its records are passed again on the next run.
 */
export function afterWrites(
  store: StorageAdapter,
  ms: number,
  fn: (written: WrittenRecord[]) => Promise<void>,
  onError: (err: unknown) => void,
): AfterWrites {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = new Map<string, WrittenRecord>();
  /** The export in progress: one at a time, so a later run never writes before an earlier one. */
  let running: Promise<void> | undefined;
  const run = async () => {
    timer = undefined;
    while (running) await running;
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    const job = (async () => {
      try {
        await fn([...batch.values()]);
      } catch (err) {
        for (const [key, rec] of batch) if (!pending.has(key)) pending.set(key, rec);
        onError(err);
      }
    })();
    running = job;
    try {
      await job;
    } finally {
      if (running === job) running = undefined;
    }
  };
  return {
    store: {
      read: (f) => store.read(f),
      write: async (f) => {
        const written: WrittenRecord[] = [];
        const result = await store.write((w) => f(tracking(w, written)));
        // Only now: a write that rolled back changed nothing.
        for (const rec of written) pending.set(`${rec.entity}:${rec.id}`, rec);
        clearTimeout(timer);
        timer = setTimeout(run, ms);
        return result;
      },
      close: () => store.close(),
    },
    // Also runs records a failed export put back, and waits for one already running.
    flush: async () => {
      clearTimeout(timer);
      await run();
      while (running) await running;
    },
  };
}
