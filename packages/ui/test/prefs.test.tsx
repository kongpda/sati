import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPrefs, usePrefs, writePrefs } from "../src/prefs.js";

const DEFAULTS = { collapsedColumns: [], theme: "system" };
const KEY = "sati.ui.v1";

const stub = (storage: Partial<Storage>) => vi.stubGlobal("localStorage", storage);
const Probe = () => <p>{usePrefs().theme}</p>;

afterEach(() => vi.unstubAllGlobals());

// D21: view preferences are a per-browser convenience. A browser that blocks storage, a
// private window or a value another version wrote must never stop the board from opening.
describe("board preferences", () => {
  it("the board still renders when storage throws or holds rubbish", () => {
    stub({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readPrefs()).toEqual(DEFAULTS);
    expect(() => writePrefs({ theme: "dark" })).not.toThrow();
    expect(renderToStaticMarkup(<Probe />)).toBe("<p>system</p>");

    for (const rubbish of ["{not json", "42", "null", '"x"', "[1]", '{"theme":7}']) {
      stub({ getItem: () => rubbish, setItem: () => undefined });
      expect(readPrefs(), rubbish).toEqual(DEFAULTS);
      expect(renderToStaticMarkup(<Probe />), rubbish).toBe("<p>system</p>");
    }
  });

  it("keeps what is valid, drops unknown keys and bad values", () => {
    const raw = JSON.stringify({
      theme: "dark",
      collapsedColumns: ["backlog", 3, "cancelled"],
      other: true,
    });
    stub({ getItem: () => raw, setItem: () => undefined });
    expect(readPrefs()).toEqual({ theme: "dark", collapsedColumns: ["backlog", "cancelled"] });
    stub({ getItem: () => '{"theme":"neon","collapsedColumns":"backlog"}' });
    expect(readPrefs()).toEqual(DEFAULTS);
  });

  it("writes a patch over what is stored, under one key", () => {
    const data = new Map<string, string>([[KEY, JSON.stringify({ theme: "light" })]]);
    stub({
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
    });
    writePrefs({ collapsedColumns: ["backlog"] });
    expect([...data.keys()]).toEqual([KEY]);
    expect(JSON.parse(data.get(KEY) ?? "")).toEqual({
      theme: "light",
      collapsedColumns: ["backlog"],
    });
    expect(readPrefs()).toEqual({ theme: "light", collapsedColumns: ["backlog"] });
  });
});
