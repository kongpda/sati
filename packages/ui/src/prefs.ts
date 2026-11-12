import { useSyncExternalStore } from "react";

/**
 * View preferences of this browser (D21): which columns are collapsed, which theme. They are
 * conveniences, not project data, so they live in `localStorage` under one key. Every read and
 * write is guarded: a blocked or full store, or text another version wrote, gives the defaults
 * and never stops the board from opening.
 */
export interface Prefs {
  collapsedColumns: string[];
  theme: "system" | "light" | "dark";
}

const KEY = "sati.ui.v1";
const THEMES: readonly string[] = ["system", "light", "dark"];
const DEFAULTS: Prefs = { collapsedColumns: [], theme: "system" };

/** Keeps the known keys with a valid value and drops the rest. */
function parse(raw: string | null): Prefs {
  if (raw === null) return DEFAULTS;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return DEFAULTS;
    const { collapsedColumns, theme } = data as Record<string, unknown>;
    return {
      collapsedColumns: Array.isArray(collapsedColumns)
        ? collapsedColumns.filter((c): c is string => typeof c === "string")
        : DEFAULTS.collapsedColumns,
      theme:
        typeof theme === "string" && THEMES.includes(theme)
          ? (theme as Prefs["theme"])
          : DEFAULTS.theme,
    };
  } catch {
    return DEFAULTS;
  }
}

function rawPrefs(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const readPrefs = (): Prefs => parse(rawPrefs());

export function writePrefs(patch: Partial<Prefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readPrefs(), ...patch }));
  } catch {
    // Nowhere to keep it: the board works the same, it just forgets next time.
  }
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of the same board changed a preference.
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

// useSyncExternalStore needs the same object back while nothing changed.
let cachedRaw: string | null | undefined;
let cached: Prefs = DEFAULTS;
function snapshot(): Prefs {
  const raw = rawPrefs();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

export const usePrefs = (): Prefs => useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
