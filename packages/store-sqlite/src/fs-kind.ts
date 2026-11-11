import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const BIND = new Set(["9p", "virtiofs", "drvfs", "prl_fs", "vboxsf"]);

/** Classifies a `stat` filesystem type. Network and bind mounts are unsafe for SQLite WAL. */
export function classifyFilesystem(fstype: string): "local" | "network" | "bind" {
  const kind = fstype.toLowerCase();
  if (BIND.has(kind)) return "bind";
  // A FUSE block device (NTFS and exFAT disks on Linux) is a local disk.
  if (kind === "fuseblk") return "local";
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
 * The filesystem type of the mount that holds `path`, from the output of macOS `mount`
 * (`//user@host/share on /Volumes/share (smbfs, nodev, nosuid)`). The longest mount point wins.
 */
export function mountedType(mountOutput: string, path: string): string | undefined {
  let best: { point: string; type: string } | undefined;
  for (const line of mountOutput.split("\n")) {
    const m = /^.+ on (\/.*) \(([^,)]+)/u.exec(line);
    const point = m?.[1];
    const type = m?.[2];
    if (!point || !type) continue;
    const inside = point === "/" || path === point || path.startsWith(`${point}/`);
    if (inside && (!best || point.length > best.point.length)) best = { point, type };
  }
  return best?.type;
}

/**
 * Best-effort. If `stat` fails, treat the disk as local so a laptop is never blocked. Windows has
 * no `stat`; there a UNC path (`\\server\share`) is a network share;
 * a mapped drive letter is not detected. On macOS `stat -f %T` prints a file-type mark, not the
 * filesystem, so the type is read from `mount`.
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
    if (platform === "darwin") {
      const mounts = execFileSync("mount", { encoding: "utf8" });
      return classifyFilesystem(mountedType(mounts, realpathSync.native(path)) ?? "");
    }
    const out = execFileSync("stat", ["-f", "-c", "%T", path], { encoding: "utf8" });
    return classifyFilesystem(out.trim());
  } catch {
    return "local";
  }
}

/** Folder names the common file-sync apps use, on macOS, Windows and Linux. */
const SYNCED: readonly [RegExp, string][] = [
  [/(^|\/)Library\/Mobile Documents(\/|$)/u, "iCloud Drive"],
  [/(^|\/)iCloudDrive(\/|$)/iu, "iCloud Drive"],
  [/(^|\/)Library\/CloudStorage\/([^/-]+)/u, ""],
  [/(^|\/)Dropbox( \([^/]+\))?(\/|$)/u, "Dropbox"],
  [/(^|\/)OneDrive( - [^/]+)?(\/|$)/u, "OneDrive"],
  [/(^|\/)(Google Drive|GoogleDrive|My Drive)(\/|$)/u, "Google Drive"],
  [/(^|\/)Box( Sync)?(\/|$)/u, "Box"],
];

/**
 * The file-sync app that keeps `path`, judged by the folder names on the way to it, or undefined.
 * A SQLite database in such a folder is copied while it is being written, and the app can put an
 * older copy back; both corrupt it. A guess from names only: nothing is opened or asked.
 */
export function syncedFolder(path: string): string | undefined {
  const posixPath = path.replaceAll("\\", "/");
  for (const [pattern, name] of SYNCED) {
    const m = pattern.exec(posixPath);
    // macOS keeps every provider under Library/CloudStorage/<Provider>-<account>.
    if (m) return name || (m[2] ?? "a file-sync app");
  }
  return undefined;
}
