import { useCallback, useMemo, useState } from "react";
import type { Snapshot } from "../api.js";
import { allInReview, moveTargets, personOnly } from "../moves.js";

/** The cards ticked for a bulk action, and what the bulk bar may offer for them. */
export function useSelection(snapshot: Snapshot | undefined) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Where the bulk menu may send the selection: any column at least one selected task can reach.
  const bulkTargets = useMemo(() => {
    const snap = snapshot;
    const targets = new Set<string>();
    if (!snap || selected.size === 0) return targets;
    for (const t of snap.tasks) {
      if (selected.has(t.id)) for (const to of moveTargets(snap, t)) targets.add(to);
    }
    return targets;
  }, [snapshot, selected]);
  // Approve and Send back for a selection of finished work; the person-only rule is core's, and
  // the board says it before the click, as the single card does.
  const reviewing = useMemo(
    () => !!snapshot && allInReview(snapshot.tasks.filter((t) => selected.has(t.id))),
    [snapshot, selected],
  );
  const approveRefusal =
    snapshot && snapshot.project?.review !== "none" ? personOnly(snapshot) : null;
  const toggle = useCallback(
    (id: string) =>
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const selectColumn = useCallback(
    (ids: string[], on: boolean) =>
      setSelected((cur) => {
        const next = new Set(cur);
        for (const id of ids) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      }),
    [],
  );

  return { selected, setSelected, toggle, selectColumn, bulkTargets, reviewing, approveRefusal };
}
