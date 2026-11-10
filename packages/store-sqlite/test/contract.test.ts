// The same contract core's in-memory test store runs, so core tests match this store (WP7).
import { storeContract } from "../../core/test/support/store-contract.js";
import { SqliteStore } from "../src/index.js";
import { tmpDb } from "./fixtures.js";

storeContract("SqliteStore", () => SqliteStore.open(tmpDb()));
