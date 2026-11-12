/** The toast itself, for either live region. */
export function toastBox(
  toast: { message: string; undo?: () => void; error?: boolean },
  setToast: (message: string | null) => void,
) {
  return (
    <div className={toast.error ? "toast error" : "toast"}>
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
