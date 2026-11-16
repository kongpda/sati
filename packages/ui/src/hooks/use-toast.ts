import { useCallback, useEffect, useState } from "react";
import { plainError } from "../words.js";
import type { Toast } from "./use-moves.js";

/**
 * The one toast on screen. Errors stay until dismissed; the rest go after a few seconds, counted
 * again from the start once the pointer and the focus leave it.
 */
export function useToast() {
  const [toast, setToastState] = useState<Toast | null>(null);
  /** The pointer or the focus is on the toast: it waits until both leave. */
  const [held, hold] = useState(false);
  const setToast = useCallback(
    (message: string | null, undo?: () => void) =>
      setToastState((shown) =>
        message === null
          ? null
          : // A plain "Saved" must not take away an Undo that is still offered: the live refresh
            // after a delete often lands a second message within the Undo's ten seconds.
            shown?.undo && !undo
            ? shown
            : { message, ...(undo ? { undo } : {}) },
      ),
    [],
  );

  const fail = useCallback((err: unknown) => {
    setToastState({ message: plainError(err), error: true });
  }, []);

  const copyFailed = useCallback(
    () =>
      setToastState({
        message: "Could not copy. Select the text and copy it by hand.",
        error: true,
      }),
    [],
  );

  // A toast that goes while held takes the pointer's or the focus's target with it.
  useEffect(() => {
    if (!toast) hold(false);
  }, [toast]);

  useEffect(() => {
    if (!toast || toast.error || held) return;
    // An Undo stays a little longer, so there is time to reach it.
    const id = window.setTimeout(() => setToast(null), toast.undo ? 10000 : 6000);
    return () => window.clearTimeout(id);
  }, [toast, held, setToast]);

  return { toast, setToast, setToastState, fail, copyFailed, hold };
}
