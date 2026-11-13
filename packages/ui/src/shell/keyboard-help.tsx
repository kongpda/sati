import { useEffect, useId, useRef } from "react";
import { SHORTCUTS } from "../hooks/use-keys.js";

/** The Keyboard dialog: every shortcut, from the same table the key handler is written beside. */
export function KeyboardHelp({ onClose }: { onClose: () => void }) {
  const heading = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [onClose]);
  return (
    <div className="palette" role="dialog" aria-modal="true" aria-labelledby={heading}>
      <button
        type="button"
        className="palette-dismiss"
        aria-label="Close keyboard help"
        tabIndex={-1}
        onClick={onClose}
      />
      <form
        className="keyboard-help"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <h2 id={heading}>Keyboard</h2>
        <table>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys}>
                <th scope="row">
                  <kbd>{s.keys}</kbd>
                </th>
                <td>{s.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button ref={closeRef} type="submit" className="primary">
          Close
        </button>
      </form>
    </div>
  );
}
