import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checks, record, rows } from "../src/render.js";
import {
  bold,
  clean,
  cleanDeep,
  detect,
  LISTED,
  markdown,
  pager,
  pipeTo,
  polish,
  setTerm,
  type Term,
  table,
  tilde,
  truncate,
  when,
  width,
  wrap,
} from "../src/term.js";

const tty = { isTTY: true, columns: 120 };
const pipe = { isTTY: false };
const person: Term = { rich: true, color: false, errColor: false, width: 60, unicode: true };
const piped: Term = { rich: false, color: false, errColor: false, width: 80, unicode: true };
const ESC = "\x1b";

afterEach(() => setTerm());

describe("terminal detection", () => {
  // Agents and scripts read piped output and pay for every character: no layout, no colour.
  it("is plain when stdout is a pipe and rich on a terminal", () => {
    expect(detect({}, pipe, pipe, "darwin")).toMatchObject({ rich: false, color: false });
    expect(detect({}, tty, tty, "darwin")).toMatchObject({ rich: true, color: true, width: 120 });
  });

  // https://no-color.org: any non-empty value turns colour off; the layout stays.
  it("follows NO_COLOR, FORCE_COLOR and TERM=dumb", () => {
    expect(detect({ NO_COLOR: "1" }, tty, tty, "darwin")).toMatchObject({
      rich: true,
      color: false,
      errColor: false,
    });
    expect(detect({ NO_COLOR: "" }, tty, tty, "darwin").color).toBe(true);
    expect(detect({ FORCE_COLOR: "1" }, pipe, pipe, "darwin")).toMatchObject({
      rich: true,
      color: true,
    });
    expect(detect({ FORCE_COLOR: "0" }, tty, tty, "darwin").color).toBe(false);
    expect(detect({ TERM: "dumb" }, tty, tty, "darwin")).toMatchObject({
      rich: false,
      color: false,
    });
  });

  // Some agent tools give the command a pseudo-terminal. A table cut to 80 columns would hide
  // the end of every title from the agent, so it gets the plain lines unless colour is forced.
  it("stays plain for an agent even on a terminal", () => {
    expect(detect({ CLAUDECODE: "1" }, tty, tty, "darwin")).toMatchObject({
      rich: false,
      color: false,
    });
    expect(detect({ AI_AGENT: "codex_1_agent" }, tty, tty, "darwin").rich).toBe(false);
    expect(detect({ CLAUDECODE: "", AI_AGENT: " " }, tty, tty, "darwin").rich).toBe(true);
    expect(detect({ CLAUDECODE: "1", FORCE_COLOR: "1" }, tty, tty, "darwin").rich).toBe(true);
  });

  // stderr can be a terminal while stdout feeds a pipe: errors keep their colour there.
  it("colours stderr on its own", () => {
    expect(detect({}, pipe, tty, "darwin")).toMatchObject({ color: false, errColor: true });
  });

  it("falls back to ASCII symbols where the glyphs are missing", () => {
    expect(detect({}, tty, tty, "win32").unicode).toBe(false);
    expect(detect({ WT_SESSION: "x" }, tty, tty, "win32").unicode).toBe(true);
    expect(detect({ TERM: "linux" }, tty, tty, "linux").unicode).toBe(false);
  });

  it("uses COLUMNS when the stream has no size, and never goes below 40", () => {
    expect(detect({ COLUMNS: "100" }, pipe, pipe, "darwin").width).toBe(100);
    expect(detect({}, { isTTY: true, columns: 10 }, tty, "darwin").width).toBe(40);
  });
});

describe("clean", () => {
  // A title is written by a teammate or an agent. Printed raw, an escape sequence in it could
  // rewrite earlier lines, set the window title or write to the clipboard (OSC 52).
  it("removes escape sequences and control characters, and keeps newlines and tabs", () => {
    expect(clean(`a${ESC}[2Jb`)).toBe("ab");
    expect(clean(`a${ESC}]0;title\x07b`)).toBe("ab");
    expect(clean(`a${ESC}]52;c;ZXZpbA==${ESC}\\b`)).toBe("ab");
    expect(clean("a\rb\x08c\x00d\x9be")).toBe("abcde");
    expect(clean("line\r\nnext\ttab")).toBe("line\nnext\ttab");
  });

  // A right-to-left override shows `tsk_1 done` where the record says something else.
  it("removes bidirectional overrides and isolates, and keeps other scripts", () => {
    expect(clean("a‮b⁦c⁩")).toBe("abc");
    expect(clean("សួស្តី 日本語 🙂")).toBe("សួស្តី 日本語 🙂");
  });

  it("cleans every string inside a record and leaves other values alone", () => {
    const at = new Date(0);
    expect(cleanDeep({ title: `x${ESC}[31m`, n: 1, tags: [`a${ESC}[0m`], at, none: null })).toEqual(
      { title: "x", n: 1, tags: ["a"], at, none: null },
    );
  });
});

describe("layout", () => {
  it("measures what the terminal shows: wide characters are two cells, colour codes none", () => {
    expect(width("abc")).toBe(3);
    expect(width("日本")).toBe(4);
    expect(width(`${ESC}[1mab${ESC}[22m`)).toBe(2);
  });

  it("cuts to a width with an ellipsis and leaves short text alone", () => {
    setTerm(person);
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 4)).toBe("abc");
    expect(width(truncate("日本語日本語", 5))).toBeLessThanOrEqual(5);
  });

  // A URL or a path cut in the middle cannot be copied, so a long word overflows instead.
  it("wraps at spaces, indents the next lines and never cuts a word", () => {
    expect(wrap("aaa bbb ccc", 7)).toBe("aaa bbb\nccc");
    expect(wrap("aaa bbb ccc", 9, "  ", 2)).toBe("aaa bbb\n  ccc");
    expect(wrap("https://example.com/long/path x", 10)).toBe("https://example.com/long/path\nx");
    expect(wrap("a\n\nb", 10)).toBe("a\n\nb");
  });

  it("aligns columns and cuts the flex column to the terminal", () => {
    setTerm({ ...person, width: 40 });
    const out = table(
      [
        ["tsk_1", "todo", "x".repeat(60)],
        ["tsk_22", "in_progress", "short"],
      ],
      { flex: 2 },
    ).split("\n");
    expect(out[1]).toBe("tsk_22  in_progress  short");
    expect(out[0]?.startsWith("tsk_1   todo         xxx")).toBe(true);
    expect(width(out[0] ?? "")).toBeLessThanOrEqual(40);
  });

  // A tab moves the cursor by an amount only the terminal knows; the next column would shift.
  it("keeps the columns in line when a cell holds a tab", () => {
    setTerm(person);
    const out = table([
      ["a\tb", "x"],
      ["abc", "y"],
    ]).split("\n");
    expect(out).toEqual(["a b  x", "abc  y"]);
  });

  // Paging is for a person at a real terminal: never into a pipe, never for a short answer.
  it("pages only output taller than a real terminal, and PAGER can turn it off", () => {
    const screen = { isTTY: true, rows: 30 };
    setTerm(person);
    expect(pager(100, {}, screen, "darwin")).toEqual({ command: "less", env: { LESS: "FRX" } });
    expect(pager(100, { PAGER: "more", LESS: "R" }, screen, "darwin")).toEqual({
      command: "more",
      env: {},
    });
    expect(pager(100, { PAGER: "more", SATI_PAGER: "bat" }, screen, "darwin")?.command).toBe("bat");
    expect(pager(10, {}, screen, "darwin")).toBeNull();
    expect(pager(100, { PAGER: "cat" }, screen, "darwin")).toBeNull();
    expect(pager(100, { PAGER: "" }, screen, "darwin")).toBeNull();
    expect(pager(100, {}, screen, "win32")).toBeNull();
    expect(pager(100, {}, { isTTY: false, rows: 30 }, "darwin")).toBeNull();
    setTerm(piped);
    expect(pager(100, {}, screen, "darwin")).toBeNull();
  });

  // The pager is the user's own command. One that is not installed must not swallow the answer.
  it.skipIf(process.platform === "win32")(
    "hands the text to the pager, and says so when the pager cannot start",
    async () => {
      const file = join(mkdtempSync(join(tmpdir(), "sati-pager-")), "out");
      expect(await pipeTo({ command: `cat > '${file}'`, env: {} }, "one\ntwo")).toBe(true);
      expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
      expect(await pipeTo({ command: "sati-no-such-pager 2>/dev/null", env: {} }, "x")).toBe(false);
    },
  );

  it("shows local time to a person and the stored ISO time to a pipe", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    setTerm(piped);
    expect(when(iso)).toBe(iso);
    expect(when(null)).toBe("");
    setTerm(person);
    expect(when(iso)).not.toContain("T03:04:05");
    expect(when(iso)).toMatch(/\d{2}:\d{2}/u);
  });

  it("shortens the home folder for a person only", () => {
    setTerm(person);
    expect(tilde("/home/ada/work", "/home/ada")).toBe("~/work");
    expect(tilde("/home/adam/work", "/home/ada")).toBe("/home/adam/work");
    setTerm(piped);
    expect(tilde("/home/ada/work", "/home/ada")).toBe("/home/ada/work");
  });
});

describe("rendering for a person and for a pipe", () => {
  const items = [
    { id: "tsk_01M755D20MTD1M3T3MQZ05CDA3", title: "First", status: "todo", priority: "high" },
    { id: "tsk_01M755D20MTD1M3T3MQZ05CDA4", title: "Second", status: "in_progress" },
  ];

  // Scripts and the agent rules parse these lines; the redesign must not change them.
  it("keeps the compact rows when piped", () => {
    setTerm(piped);
    expect(rows(items, "none")).toBe(
      "tsk_05cda3  todo  high  First\ntsk_05cda4  in_progress  Second",
    );
    expect(record({ ...items[0], labels: ["a"], claim: { token: 2 } } as never)).toBe(
      'tsk_05cda3  todo  high  First\n  id: tsk_01M755D20MTD1M3T3MQZ05CDA3\n  labels: ["a"]\n  claim: {"token":2}',
    );
    expect(checks([{ name: "locks", ok: false, detail: "1 expired" }])).toBe(
      "fail locks: 1 expired",
    );
    expect(markdown("## Ready\n- tsk_1 x")).toBe("## Ready\n- tsk_1 x");
    expect(polish("Created tsk_1\nhint: Run `sati next`.")).toBe(
      "Created tsk_1\nhint: Run `sati next`.",
    );
  });

  it("aligns rows, counts checks and marks finished actions for a person", () => {
    setTerm(person);
    expect(rows(items, "none")).toBe(
      "tsk_05cda3  todo         high  First\ntsk_05cda4  in_progress        Second",
    );
    expect(rows([], "none")).toBe("none");
    const out = checks([
      { name: "locks", ok: false, detail: "1 expired" },
      { name: "links", ok: true, detail: "sound" },
    ]);
    expect(out).toBe("✖ locks  1 expired\n✔ links  sound\n\n1 failed, 1 passed.");
    expect(polish("Created tsk_1")).toBe("✔ Created tsk_1");
    expect(polish("No tasks.")).toBe("No tasks.");
    // A list that opens with stored text says so: an author called "Created by hand" did nothing.
    expect(polish(`${LISTED}Created by hand  now`)).toBe("Created by hand  now");
  });

  it("adds colour codes only when colour is on", () => {
    setTerm(person);
    expect(bold("x")).toBe("x");
    setTerm({ ...person, color: true });
    expect(bold("x")).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(markdown("## Ready")).toContain(`${ESC}[1m`);
  });
});
