import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * SHA-256 of a file's bytes, or undefined when there is no file there. Read in pieces: a
 * deliverable may be a video of several gigabytes. The bytes are hashed and dropped, never kept.
 */
export function fileSha256(path: string): string | undefined {
  let fd: number;
  try {
    if (!statSync(path).isFile()) return undefined;
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
