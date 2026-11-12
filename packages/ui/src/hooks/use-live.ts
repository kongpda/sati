import type { QueryClient } from "@tanstack/react-query";
import { type MutableRefObject, useEffect, useRef } from "react";
import type { Snapshot } from "../api.js";

/**
 * Keeps the board current: the server's event stream refetches the snapshot, and the tasks that
 * changed are marked "new" for a moment. `moving` counts board moves still in flight.
 */
export function useLive(
  client: QueryClient,
  moving: MutableRefObject<number>,
  setOffline: (offline: boolean) => void,
  setExpired: (expired: boolean) => void,
  setFresh: (ids: Set<string>) => void,
) {
  /** Clears the "new" highlight; a newer event restarts it, so it is kept to cancel. */
  const freshTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const source = new EventSource("/events");
    // No refetch on (re)connect: the server sends a message at once when anything was written
    // since the last event this tab saw (Last-Event-ID), and stays quiet when nothing was.
    source.onopen = () => setOffline(false);
    source.onerror = () => {
      setOffline(true);
      // EventSource retries a dropped connection itself, but gives up for good on a refused
      // one (401): the link this tab signed in with is gone.
      if (source.readyState === EventSource.CLOSED) setExpired(true);
    };
    source.onmessage = () => {
      // A move in flight invalidates the snapshot itself when it settles.
      if (moving.current > 0) return;
      const previous = client.getQueryData<Snapshot>(["snapshot"]);
      void client.invalidateQueries({ queryKey: ["snapshot"] }).then(() => {
        const next = client.getQueryData<Snapshot>(["snapshot"]);
        if (!previous || !next) return;
        const before = new Map(previous.tasks.map((t) => [t.id, t.updatedAt]));
        const changed = next.tasks.filter((t) => before.get(t.id) !== t.updatedAt).map((t) => t.id);
        if (changed.length === 0) return;
        setFresh(new Set(changed));
        window.clearTimeout(freshTimer.current);
        freshTimer.current = window.setTimeout(() => setFresh(new Set()), 1600);
      });
    };
    return () => {
      source.close();
      window.clearTimeout(freshTimer.current);
    };
  }, [client, moving, setOffline, setExpired, setFresh]);
}
