import type { QueryClient } from "@tanstack/react-query";
import { type Dispatch, type SetStateAction, useRef } from "react";
import { api, type Snapshot } from "../api.js";
import { moveRefusal, needsReason } from "../moves.js";
import { plainError } from "../words.js";

/** The branch commit a person sees when approving, so a later push is not approved unseen. */
export function approvedCommit(data: Snapshot, id: string): { approvedCommit?: string } {
  const head = data.drift?.[id]?.head;
  return head ? { approvedCommit: head } : {};
}

export type Toast = { message: string; undo?: () => void; error?: boolean };
export type SendingBack = { ids: string[]; status: string; bulk: boolean };

/**
 * Board moves: one at a time per card, optimistic, with the refusal reasons gathered for a bulk
 * move. `moving` counts the moves in flight so live refetches wait for them.
 */
export function useMoves(
  client: QueryClient,
  moving: { current: number },
  setToastState: Dispatch<SetStateAction<Toast | null>>,
  fail: (err: unknown) => void,
  setSelected: Dispatch<SetStateAction<Set<string>>>,
  setSendingBack: Dispatch<SetStateAction<SendingBack | null>>,
) {
  /** The last move of each task still in flight; the next move of that task waits for it. */
  const moveQueue = useRef(new Map<string, Promise<boolean>>());

  /**
   * Resolves true when the task moved. Pass `onFail` to report the reason yourself. A second
   * move of the same card waits for the first: sent at once, it carried the version from
   * before the first move and the server refused it as a conflict.
   */
  function move(
    id: string,
    status: string,
    onFail?: (reason: string) => void,
    reason?: string,
  ): Promise<boolean> {
    const run = (moveQueue.current.get(id) ?? Promise.resolve(true)).then(() =>
      moveNow(id, status, onFail, reason),
    );
    moveQueue.current.set(id, run);
    void run.finally(() => {
      if (moveQueue.current.get(id) === run) moveQueue.current.delete(id);
    });
    return run;
  }

  async function moveNow(
    id: string,
    status: string,
    onFail?: (reason: string) => void,
    reason?: string,
  ): Promise<boolean> {
    const current = client.getQueryData<Snapshot>(["snapshot"]);
    const item = current?.tasks.find((t) => t.id === id);
    if (!current || !item || item.status === status) return false;
    // What core is certain to refuse is not sent: the card would jump to the column and back.
    const refusal = moveRefusal(current, item, status);
    if (refusal) {
      (onFail ?? ((message: string) => setToastState({ message, error: true })))(refusal);
      return false;
    }
    // A refetch already in flight would overwrite the optimistic status with the old one.
    moving.current++;
    await client.cancelQueries({ queryKey: ["snapshot"] });
    client.setQueryData<Snapshot>(["snapshot"], (snap) =>
      snap ? { ...snap, tasks: snap.tasks.map((t) => (t.id === id ? { ...t, status } : t)) } : snap,
    );
    try {
      const updated = await api.patchTask(id, {
        status,
        expectedVersion: item.version,
        ...(reason ? { reason } : {}),
        ...(status === "done" ? approvedCommit(current, id) : {}),
      });
      // The refetch waits for the other moves; a queued move of this card needs the version now.
      client.setQueryData<Snapshot>(["snapshot"], (snap) =>
        snap
          ? {
              ...snap,
              tasks: snap.tasks.map((t) =>
                t.id === id ? { ...t, status: updated.status, version: updated.version } : t,
              ),
            }
          : snap,
      );
      moving.current--;
      // Refetch once the last move lands: an earlier refetch would bring back the old status of
      // the cards still in flight, and they would jump back.
      if (moving.current === 0) await client.invalidateQueries({ queryKey: ["snapshot"] });
      return true;
    } catch (err) {
      moving.current--;
      // Revert only this task: other moves may be in flight, and a whole-snapshot restore
      // would undo them or bring back their refused state.
      client.setQueryData<Snapshot>(["snapshot"], (snap) =>
        snap
          ? {
              ...snap,
              tasks: snap.tasks.map((t) => (t.id === id ? { ...t, status: item.status } : t)),
            }
          : snap,
      );
      if (onFail) onFail(plainError(err));
      else fail(err);
      if (moving.current === 0) await client.invalidateQueries({ queryKey: ["snapshot"] });
      return false;
    }
  }

  /**
   * Moves the tasks and says what did not move, each reason once with how many tasks it stopped.
   * Tasks already in the column are left out of the count.
   */
  async function moveMany(ids: string[], status: string, bulk: boolean, reason?: string) {
    const why = new Map<string, number>();
    const results = await Promise.all(
      ids.map((id) =>
        move(id, status, (message) => why.set(message, (why.get(message) ?? 0) + 1), reason),
      ),
    );
    const failed = ids.filter((_, i) => !results[i]);
    if (bulk) setSelected(new Set(failed));
    if (why.size === 0) return;
    const stopped = [...why.values()].reduce((a, b) => a + b, 0);
    const reasons = [...why].map(([message, n]) =>
      why.size === 1 ? message : `${n} ${n === 1 ? "task" : "tasks"}: ${message}`,
    );
    // An error toast stays until it is closed; the plain one is gone after 6 seconds.
    setToastState({
      message: !bulk
        ? (reasons[0] ?? "")
        : `${stopped} of ${ids.length} tasks did not move. ${reasons.join(" ")}`,
      error: true,
    });
  }

  /** A move from a drag or the bulk menu. Work sent back from review asks for the reason first. */
  function requestMove(ids: string[], status: string, bulk = false) {
    const current = client.getQueryData<Snapshot>(["snapshot"]);
    const asks = ids.some((id) => {
      const item = current?.tasks.find((t) => t.id === id);
      return current && item && needsReason(item, status) && !moveRefusal(current, item, status);
    });
    if (asks) setSendingBack({ ids, status, bulk });
    else void moveMany(ids, status, bulk);
  }

  return { moveMany, requestMove };
}
