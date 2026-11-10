import { MemoryStore } from "./support/memory-store.js";
import { storeContract } from "./support/store-contract.js";

storeContract("MemoryStore", async () => new MemoryStore());
