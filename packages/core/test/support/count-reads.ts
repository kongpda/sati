import type { ServiceContext, StorageAdapter, StorageReader } from "../../src/index.js";

/**
 * The same context with a store that records the ids each `list` call returns, by entity. A
 * test of "reads only what it needs" checks these, not how long the call took.
 */
export function countingReads(ctx: ServiceContext): {
  ctx: ServiceContext;
  listed: (entity: string) => string[];
  /** Every `list` query, in call order. */
  queries: Parameters<StorageReader["list"]>[];
} {
  const seen = new Map<string, string[]>();
  const queries: Parameters<StorageReader["list"]>[] = [];
  const store: StorageAdapter = ctx.store;
  const wrap = <R extends StorageReader>(r: R): R => ({
    ...r,
    list: async (...args: Parameters<StorageReader["list"]>) => {
      queries.push(args);
      const rows = await r.list(...args);
      seen.set(args[0], [...(seen.get(args[0]) ?? []), ...rows.map((x) => x.id)]);
      return rows;
    },
  });
  const counting: StorageAdapter = {
    read: (fn) => store.read((r) => fn(wrap(r))),
    write: (fn) => store.write((w) => fn(wrap(w))),
    close: () => store.close(),
  };
  return { ctx: { ...ctx, store: counting }, listed: (e) => seen.get(e) ?? [], queries };
}
