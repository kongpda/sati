/** The toast itself, for either live region. */
export function toastBox(
  toast: { message: string; undo?: () => void; error?: boolean },
  setToast: (message: string | null) => void,
  hold: (held: boolean) => void,
) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handlers only pause the timer while a person reads or reaches a button
    <div
      className={toast.error ? "toast error" : "toast"}
      onMouseEnter={() => hold(true)}
      onMouseLeave={() => hold(false)}
      onFocus={() => hold(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) hold(false);
      }}
    >
      <span className="toast-text">{toast.message}</span>
      <span className="toast-actions">
        {toast.undo ? (
          <button
            type="button"
            className="undo"
            onClick={() => {
              toast.undo?.();
              setToast(null);
            }}
          >
            Undo
          </button>
        ) : null}
        <button type="button" onClick={() => setToast(null)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}
