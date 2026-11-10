import { execFileSync } from "node:child_process";

const BIND = new Set(["9p", "virtiofs", "drvfs", "prl_fs", "vboxsf"]);

/** Classifies a `stat` filesystem type. Network and bind mounts are unsafe for SQLite WAL. */
export function classifyFilesystem(fstype: string): "local" | "network" | "bind" {
  const kind = fstype.toLowerCase();
  if (BIND.has(kind)) return "bind";
  if (
    kind.includes("nfs") ||
    kind.includes("smb") ||
    kind.includes("cifs") ||
    kind.includes("fuse") ||
    kind === "afpfs" ||
    kind === "webdav"
  ) {
    return "network";
  }
  return "local";
}

/**
 * Best-effort. If `stat` fails, treat the disk as local so a laptop is never blocked. Windows has
 * no `stat`; there a UNC path (`\\server\share`) is a network share;
 * a mapped drive letter is not detected.
 */
export function filesystemKind(
  path: string,
  platform: NodeJS.Platform = process.platform,
): "local" | "network" | "bind" {
  if (platform === "win32") {
    const unc = /^\\\\(?:\?\\UNC\\|[^?.\\])/iu;
    return unc.test(path) ? "network" : "local";
  }
  try {
    const args = platform === "darwin" ? ["-f", "%T", path] : ["-f", "-c", "%T", path];
    return classifyFilesystem(execFileSync("stat", args, { encoding: "utf8" }).trim());
  } catch {
    return "local";
  }
}
