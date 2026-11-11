import { SatiError } from "@sati/core";

export interface Launcher {
  /** File name, with the extension the platform opens on a double click. */
  file: string;
  body: string;
  /** Unix mode: the file must be executable to start on a double click. */
  mode: number;
}

const shQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
/** A quoted argument of a desktop entry's `Exec` key. */
const desktopQuote = (s: string) => `"${s.replace(/["`$\\]/gu, "\\$&").replaceAll("%", "%%")}"`;

/**
 * A file that starts the board for one project on a double click, for a person who never opens
 * a terminal: a `.command` on macOS, a `.cmd` on Windows, a desktop entry elsewhere. It names the
 * project folder and the binary by their full paths, so it works from any folder it is moved to.
 */
export function launcherFile(
  platform: NodeJS.Platform,
  self: readonly string[],
  root: string,
  project: string,
): Launcher {
  const title = `${project.replace(/[\\/:*?"<>|\r\n]+/gu, "-").trim() || "sati"} board`;
  if (platform === "win32") {
    const words = [root, ...self];
    // cmd has no way to quote these inside a quoted word.
    if (words.some((w) => /["%\r\n]/u.test(w))) {
      throw new SatiError("USAGE", 'A launcher cannot hold a path with `"` or `%` on Windows.');
    }
    const body = [
      "@echo off",
      `cd /d "${root}"`,
      `${self.map((w) => `"${w}"`).join(" ")} ui`,
      "if errorlevel 1 pause",
      "",
    ].join("\r\n");
    return { file: `${title}.cmd`, body, mode: 0o644 };
  }
  if (platform === "darwin") {
    const body = [
      "#!/bin/sh",
      `cd ${shQuote(root)} || exit 1`,
      `exec ${self.map(shQuote).join(" ")} ui`,
      "",
    ].join("\n");
    return { file: `${title}.command`, body, mode: 0o755 };
  }
  if (/[\r\n]/u.test(root)) throw new SatiError("USAGE", "The project path holds a line break.");
  const body = [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${title}`,
    `Path=${root}`,
    `Exec=${self.map(desktopQuote).join(" ")} ui`,
    "Terminal=true",
    "",
  ].join("\n");
  return { file: `${title}.desktop`, body, mode: 0o755 };
}
