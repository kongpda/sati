import { useSyncExternalStore } from "react";
import { ago } from "./api.js";

// One timer for every relative time on screen: each minute they all re-render, so "just now"
// turns into "1 min ago" without waiting for a write to refresh the page.
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= window.setInterval(() => {
    for (const l of listeners) l();
  }, 60_000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const minute = () => Math.floor(Date.now() / 60_000);

/**
 * Re-renders its caller each minute. For what depends on the clock and not on a write, such as
 * whether a claim's lease has run out. It does not refetch.
 */
export function useMinute(): number {
  return useSyncExternalStore(subscribe, minute);
}

/** "3 min ago" for `iso`, kept current while it is on screen. */
export function Ago({ iso }: { iso: string }) {
  useMinute();
  return <>{ago(iso)}</>;
}
