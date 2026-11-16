/**
 * Wraps `run` so calls closer together than `gap` ms share one run: the first call runs at
 * once, and any calls during the gap run once when it ends. `cancel` drops a pending run.
 */
export function coalesce(run: () => void, gap: number): (() => void) & { cancel: () => void } {
  let last = Number.NEGATIVE_INFINITY;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const call = () => {
    if (pending !== undefined) return;
    pending = setTimeout(
      () => {
        pending = undefined;
        last = Date.now();
        run();
      },
      Math.max(0, last + gap - Date.now()),
    );
  };
  call.cancel = () => {
    clearTimeout(pending);
    pending = undefined;
  };
  return call;
}
