import { useEffect, useState } from "react";
import { platform } from "../platform";

/** Minimise / maximise-restore / close for the frameless editor window (as in ReeliF Studio). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    let gone = false;
    void platform.window
      .onMaximizedChange(setMaximized)
      .then((u) => (gone ? u() : (off = u)))
      .catch(() => undefined);
    return () => {
      gone = true;
      off?.();
    };
  }, []);

  return (
    <div className="win-controls" role="group" aria-label="Window">
      <button className="win-btn" onClick={() => void platform.window.minimize()} aria-label="Minimise" title="Minimise">
        <svg viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button className="win-btn" onClick={() => void platform.window.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximise"} title={maximized ? "Restore" : "Maximise"}>
        {maximized ? (
          <svg viewBox="0 0 10 10" aria-hidden>
            <path d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z" />
          </svg>
        ) : (
          <svg viewBox="0 0 10 10" aria-hidden>
            <path d="M0.5 0.5h9v9h-9z" />
          </svg>
        )}
      </button>
      <button className="win-btn close" onClick={() => void platform.window.close()} aria-label="Close" title="Close">
        <svg viewBox="0 0 10 10" aria-hidden>
          <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
        </svg>
      </button>
    </div>
  );
}
