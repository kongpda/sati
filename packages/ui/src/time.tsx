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

/** "3 min ago" for `iso`, kept current while it is on screen. */
export function Ago({ iso }: { iso: string }) {
  useSyncExternalStore(subscribe, minute);
  return <>{ago(iso)}</>;
}
