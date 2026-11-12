import { createHash } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname, uptime, userInfo } from "node:os";
import type { ClaimHolder, ProcessProbe } from "@sati/core";

export function osUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * Names the place a process id means something: this boot of this machine, in this PID namespace.
 * A hostname alone is shared by every cloud sandbox and by containers on host networking, and a
 * clone there must never take another machine's live process for an exited one. Claims are
 * exported to `.sati/` and committed, so the key is a hash, not the names themselves.
 */
function machineKey(): string {
  const parts = [hostname()];
  const read = (f: () => string) => {
    try {
      parts.push(f());
      return true;
    } catch {
      return false;
    }
  };
  const boot = read(() => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
  const pidNs = read(() => readlinkSync("/proc/self/ns/pid"));
  // Without /proc (macOS, Windows): the boot time, to the minute. Two processes that round it
  // differently only see each other as unknown, which never releases anything.
  if (!boot && !pidNs) parts.push(String(Math.round(Date.now() / 60_000 - uptime() / 60)));
  return `h:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

/**
 * Process checks for claim holders. A process on this host is alive while `kill(pid, 0)`
 * succeeds or is refused for permission; `ESRCH` is the one answer that proves it has exited.
 * Another host, or any other error, is unknown. `self` names this process for long-lived
 * servers only (see ProcessProbe).
 */
export function processProbe(long: boolean): ProcessProbe {
  const host = machineKey();
  const probe: ProcessProbe = {
    alive: (holder: ClaimHolder) => {
      if (holder.host !== host) return null;
      try {
        process.kill(holder.pid, 0);
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM") return true;
        return code === "ESRCH" ? false : null;
      }
    },
  };
  if (long) probe.self = { host, pid: process.pid };
  return probe;
}
