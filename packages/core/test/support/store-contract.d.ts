import type { StorageAdapter } from "../../src/index.js";
/**
 * What every StorageAdapter must do, run against the in-memory test store and SqliteStore.
 * Core tests run on the memory store; if it differs from the real one, they can pass on
 * behaviour users never get (review WP7). Only types come from core, so `store-sqlite` can run
 * this file against its own build of core without a second copy of the classes.
 */
export declare function storeContract(name: string, open: () => Promise<StorageAdapter>): void;
