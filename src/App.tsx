import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import logo from "./assets/capturely-logo.png";
import { platform } from "./platform";
import { FilmIcon, FolderOpenIcon } from "./ui/icons";
import { LibraryPage } from "./ui/LibraryPage";
import { reducedMotion } from "./ui/motion";
import { TakePage } from "./ui/TakePage";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import { WindowControls } from "./ui/WindowControls";

type Page = { id: "library" } | { id: "take"; take: string };

/** A take's folder name is its title. */
const takeName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "Recording";

/**
 * The editor window: a title bar like ReeliF Studio's (brand and pages, the open recording in the
 * middle, actions and window buttons on the right), then the library or a finished recording. It
 * always opens on the library; a recording opens from there.
 */
export default function App() {
  const [page, setPage] = useState<Page | null>(null);
  // The take just recorded: the window opens on the library with it marked, not on the editor.
  const [fresh, setFresh] = useState<string | null>(null);
  const nav = useRef<HTMLDivElement | null>(null);
  const pill = useRef<HTMLSpanElement | null>(null);
  const tab = page?.id ?? "library";
  const show = (take: string | null) => {
    setFresh(take);
    setPage({ id: "library" });
  };

  useEffect(() => {
    void platform.editor
      .firstTake()
      .then(show)
      .catch(() => show(null));
    let off: (() => void) | null = null;
    void platform.editor.onOpen(show).then((u) => (off = u));
    return () => off?.();
  }, []);

  // The highlight glides between Library and the open recording.
  useLayoutEffect(() => {
    const btn = nav.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (!btn || !pill.current) return;
    gsap.to(pill.current, { x: btn.offsetLeft, width: btn.offsetWidth, duration: reducedMotion() ? 0 : 0.32, ease: "power3.out" });
  }, [tab, page]);

  const newRecording = () => {
    void platform.bar.show();
    void platform.window.minimize();
  };

  return (
    <div className="app">
      <header className="topbar" data-tauri-drag-region>
        <div className="topbar-left" data-tauri-drag-region>
          <img className="brand-logo" src={logo} alt="" width={20} height={20} data-tauri-drag-region />
          <span className="brand-name" data-tauri-drag-region>
            Capturely
          </span>
          <nav className="topnav" ref={nav} aria-label="Pages">
            <span className="topnav-pill" ref={pill} aria-hidden />
            <button data-tab="library" className={tab === "library" ? "on" : ""} onClick={() => setPage({ id: "library" })}>
              <FolderOpenIcon aria-hidden /> Library
            </button>
            {page?.id === "take" && (
              <button data-tab="take" className="on">
                <FilmIcon aria-hidden /> Recording
              </button>
            )}
          </nav>
        </div>
        <div className="topbar-center" data-tauri-drag-region>
          <span className="project-title" title={page?.id === "take" ? page.take : ""} data-tauri-drag-region>
            {page?.id === "take" ? takeName(page.take) : "All recordings"}
          </span>
        </div>
        <div className="top-actions glide">
          <span className="glide-pill" aria-hidden />
          <ThemeSwitch />
          <button className="btn rec-new" onClick={newRecording} title="Show the capture bar and record again">
            <span className="rec-dot" aria-hidden /> New recording
          </button>
          <WindowControls />
        </div>
      </header>
      {page?.id === "library" && <LibraryPage key={fresh ?? "all"} fresh={fresh} onOpen={(take) => setPage({ id: "take", take })} onRecord={newRecording} />}
      {page?.id === "take" && <TakePage key={page.take} take={page.take} onDeleted={() => setPage({ id: "library" })} />}
    </div>
  );
}
