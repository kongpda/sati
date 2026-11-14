import { useCallback, useEffect, useState } from "react";

/** How many rows a long list draws before "Show more". */
export const PAGE = 50;

/** The event `show` sends when the row it wants is not drawn yet. */
export const REVEAL = "sati:reveal";

/**
 * A long list drawn in pages. Rows past the first page are not in the DOM, so a link to one
 * (`show` in `app.tsx`) sends `REVEAL` with the id; the list grows to hold it, then the row
 * is scrolled to and focused as for any other.
 */
export function usePaged<T extends { id: string }>(items: readonly T[]) {
  const [count, setCount] = useState(PAGE);
  useEffect(() => {
    const reveal = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      const at = items.findIndex((item) => item.id === id);
      if (at >= 0) setCount((n) => Math.max(n, at + 1));
    };
    window.addEventListener(REVEAL, reveal);
    return () => window.removeEventListener(REVEAL, reveal);
  }, [items]);
  const more = useCallback(() => setCount((n) => n + PAGE), []);
  return { shown: items.slice(0, count), hidden: Math.max(0, items.length - count), more };
}
