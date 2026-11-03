import type { StorageAdapter } from "@sati/core";

export interface AfterWrites {
  /** The store to hand to services; its writes schedule `fn`. */
  store: StorageAdapter;
  /** Runs a pending `fn` now, for shutdown. */
  flush(): Promise<void>;
}

/**
 * Wraps a store so `fn` runs `ms` after the last successful write (debounced). Errors from `fn`
 * go to `onError`; they never fail the write that scheduled it.
 */
export function afterWrites(
  store: StorageAdapter,
  ms: number,
  fn: () => Promise<void>,
  onError: (err: unknown) => void,
): AfterWrites {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    timer = undefined;
    try {
      await fn();
    } catch (err) {
      onError(err);
    }
  };
  return {
    store: {
      read: (f) => store.read(f),
      write: async (f) => {
        const result = await store.write(f);
        clearTimeout(timer);
        timer = setTimeout(run, ms);
        return result;
      },
      close: () => store.close(),
    },
    flush: async () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      await run();
    },
  };
}
