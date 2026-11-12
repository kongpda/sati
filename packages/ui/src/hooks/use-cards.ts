import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api, type Snapshot, type Task } from "../api.js";
import { heldByOther, moveRefusal } from "../moves.js";
import { holderName } from "../people.js";

/** Handlers handed to every board card. */
export function useCards(
  client: QueryClient,
  data: Snapshot | undefined,
  requestMove: (ids: string[], status: string) => void,
  fail: (err: unknown) => void,
  go: (next: string, taskId?: string | null) => boolean,
) {
  // Stable handlers, so a memoised card re-renders only when its own task changes.
  const latest = useRef({ data, requestMove });
  latest.current = { data, requestMove };
  const openTask = useCallback((id: string) => go("/", id), [go]);
  const reviewed = useCallback(
    (id: string) => {
      const item = latest.current.data?.tasks.find((t) => t.id === id);
      if (!item) return;
      void api
        .patchTask(id, { reviewed: true, expectedVersion: item.version })
        .then(() => client.invalidateQueries({ queryKey: ["snapshot"] }))
        .catch(fail);
    },
    [client, fail],
  );
  const refusal = useCallback(
    (t: Task, status: string) => (data ? moveRefusal(data, t, status) : null),
    [data],
  );
  const heldBy = useCallback(
    (t: Task) => (data && heldByOther(data, t) ? holderName(data, t.claim?.actorId) : null),
    [data],
  );
  const moveCard = useCallback((id: string, status: string) => {
    latest.current.requestMove([id], status);
  }, []);

  return { openTask, reviewed, refusal, heldBy, moveCard };
}
