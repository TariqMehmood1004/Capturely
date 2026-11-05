import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { errorMessage, platform, type Hotkey, type TakeData, type TakeInfo } from "../platform";
import { Segmented } from "./controls";
import { ArrowDownTrayIcon, CheckIcon, ComputerDesktopIcon, CursorArrowRaysIcon, PhotoIcon, SparklesIcon, DocumentArrowUpIcon, FilmIcon, FolderOpenIcon, MagnifyingGlassIcon, PlayIcon, TrashIcon, VideoCameraIcon, ViewfinderCircleIcon, WindowIcon, XMarkIcon } from "./icons";
import { formatTime, MOTION, reducedMotion } from "./motion";

const samePath = (a: string, b?: string | null) => !!b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Every recording in Videos\Capturely: searchable, in a chosen order, grouped by day when sorted
 * by date; `fresh` (just recorded) is marked. Each card has a delete button (press twice: it asks
 * first). "Select" picks several, or all shown, to delete together.
 */
export function LibraryPage({ fresh, onOpen, onRecord }: { fresh?: string | null; onOpen: (take: string) => void; onRecord: () => void }) {
  const [takes, setTakes] = useState<TakeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  /** The card whose delete button was pressed once (the next press deletes). */
  const [asking, setAsking] = useState<string | null>(null);
  const [confirmMany, setConfirmMany] = useState(false);
  const [busy, setBusy] = useState(false);
  const grid = useRef<HTMLDivElement | null>(null);
  // Select all / none: the cards change one after another for a moment (CSS delays by index).
  const [cascade, setCascade] = useState(false);
  const cascadeTimer = useRef(0);
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<Sort>(loadSort);
  const setSort = (s: Sort) => {
    setSortState(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      /* not remembered */
    }
  };
  const [keys, setKeys] = useState<Hotkey[]>([]);
  useEffect(() => void platform.hotkeys().then(setKeys, () => undefined), []);
  const pickAll = (on: boolean) => {
    if (!takes) return;
    window.clearTimeout(cascadeTimer.current);
    setCascade(true);
    const q = query.trim().toLowerCase();
    setPicked(on ? new Set(takes.filter((t) => !q || t.name.toLowerCase().includes(q)).map((t) => t.path)) : new Set());
    cascadeTimer.current = window.setTimeout(() => setCascade(false), 450 + takes.length * 45);
  };
  useEffect(() => () => window.clearTimeout(cascadeTimer.current), []);
  const animated = useRef(false);
  // Library stills made now for takes without one, one after another (a JPEG per card, not a video).
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!takes) return;
    let live = true;
    void (async () => {
      for (const t of takes.filter((x) => !x.thumb && x.video)) {
        if (!live) return;
        const p = await platform.takeThumb(t.path).catch(() => null);
        if (p && live) setThumbs((m) => ({ ...m, [t.path]: p }));
      }
    })();
    return () => {
      live = false;
    };
  }, [takes]);
  const [importing, setImporting] = useState<number | null>(null);

  /** Open a video file as a new take: converted into the library, then opened in the editor. */
  const openVideo = async () => {
    setError(null);
    setImporting(0);
    try {
      const job = platform.libraryImport();
      const off = await job.onProgress((p) => p >= 0 && setImporting(p));
      const got = await job.promise.finally(off);
      if (!got) return;
      const data: TakeData = { version: 1, createdAt: new Date().toISOString(), duration: got.duration, width: got.width, height: got.height, fps: got.fps, source: "import", clicks: [], path: [], markers: [], zoom: { on: false, depth: 1.8, hold: 1.5, after: "follow" }, ripples: false, camera: null };
      await platform.takeSave(got.take, data);
      onOpen(got.take);
    } catch (e) {
      setError(`The video could not be opened: ${errorMessage(e)}`);
    } finally {
      setImporting(null);
    }
  };
  const openProject = async () => {
    setError(null);
    try {
      const take = await platform.projectOpen();
      if (take) onOpen(take);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    platform
      .library()
      .then(setTakes)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  // An empty library: its parts rise in one after another.
  const empty = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!empty.current || reducedMotion()) return;
    gsap.fromTo(empty.current.children, { y: MOTION.rise, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: MOTION.base + 0.1, ease: MOTION.ease, stagger: 0.07, clearProps: "transform,opacity,visibility" });
  }, [takes?.length === 0]);

  // The cards rise in once (not again after a delete).
  useLayoutEffect(() => {
    if (!grid.current || !takes?.length || animated.current || reducedMotion()) return;
    animated.current = true;
    gsap.fromTo(grid.current.querySelectorAll(".lib-group > h3, .lib-card"), { y: MOTION.rise, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: MOTION.base, ease: MOTION.ease, stagger: MOTION.stagger, clearProps: "transform,opacity,visibility" });
  }, [takes]);

  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
    setConfirmMany(false);
  };

  // Esc leaves selecting; Ctrl+A selects every recording while selecting.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAsking(null);
        if (selecting) stopSelecting();
      } else if (selecting && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && takes) {
        e.preventDefault();
        pickAll(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selecting, takes]);

  /** Delete takes one after another; the cards fade out as they go. */
  /** Where the cards still shown were before a delete (to glide them to their new places). */
  const flip = useRef<Map<string, DOMRect> | null>(null);

  /** Delete takes one after another: each card flashes red and shrinks away as its folder goes,
   *  then the others glide into the gaps. */
  const remove = async (paths: string[]) => {
    setBusy(true);
    setError(null);
    const still = reducedMotion();
    const card = (p: string) => grid.current?.querySelector<HTMLElement>(`[data-take="${CSS.escape(p)}"]`) ?? null;
    const gone: string[] = [];
    let last: Promise<unknown> = Promise.resolve();
    for (const p of paths) {
      try {
        await platform.takeDelete(p);
        gone.push(p);
      } catch (e) {
        setError(`Could not delete ${p.split(/[\\/]/).pop()}: ${errorMessage(e)}`);
        break;
      }
      const el = card(p);
      if (el && !still) {
        el.classList.add("leaving");
        last = gsap
          .timeline()
          .to(el, { scale: 1.03, duration: 0.12, ease: "power2.out" })
          .to(el, { scale: 0.82, autoAlpha: 0, duration: 0.28, ease: "power3.in" })
          .then(() => undefined);
        // A short beat between cards, so several go one after another.
        if (paths.length > 1) await new Promise((r) => setTimeout(r, 70));
      }
    }
    // At most a short wait: animation frames stop while the window is hidden.
    if (!still) await Promise.race([last, new Promise((r) => setTimeout(r, 450))]);
    const map = new Map<string, DOMRect>();
    grid.current?.querySelectorAll<HTMLElement>("[data-take]").forEach((el) => !gone.includes(el.dataset.take ?? "") && map.set(el.dataset.take ?? "", el.getBoundingClientRect()));
    flip.current = still ? null : map;
    setTakes((list) => list?.filter((t) => !gone.includes(t.path)) ?? null);
    setPicked((s) => new Set([...s].filter((p) => !gone.includes(p))));
    setAsking(null);
    setConfirmMany(false);
    setBusy(false);
  };

  // After a delete: every card that moved starts where it was and glides to its new place.
  useLayoutEffect(() => {
    const before = flip.current;
    flip.current = null;
    if (!before || !grid.current) return;
    grid.current.querySelectorAll<HTMLElement>("[data-take]").forEach((el, i) => {
      const was = before.get(el.dataset.take ?? "");
      if (!was) return;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      gsap.fromTo(el, { x: dx, y: dy }, { x: 0, y: 0, duration: 0.5, ease: "power3.out", delay: i * 0.02, clearProps: "transform" });
    });
  }, [takes]);

  const toggle = (path: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // What is shown: the search, then the chosen order, then grouped by day.
  const q = query.trim().toLowerCase();
  const shown = sortTakes((takes ?? []).filter((t) => !q || t.name.toLowerCase().includes(q)), sort);
  const groups = sort === "newest" || sort === "oldest" ? groupByDay(shown) : shown.length ? [{ label: SORTS.find((s) => s.id === sort)!.label, takes: shown }] : [];
  const all = shown.length > 0 && shown.every((t) => picked.has(t.path));
  const total = (takes ?? []).reduce((sum, t) => sum + t.bytes, 0);
  const folder = takes?.[0]?.path.replace(/[\\/][^\\/]+[\\/]?$/, "") ?? null;
  const recordKey = keys.find((k) => k.action === "record" && k.ready)?.keys;
  let index = 0;

  return (
    <div className="page lib">
      <header className="lib-head">
        <div className="lib-title">
          <h2>Library</h2>
          <span className="lib-stats">
            {takes ? (takes.length ? `${plural(takes.length, "recording")} · ${size(total)}` : "Nothing recorded yet") : "Loading…"}
            {folder && (
              <button className="lib-folder" onClick={() => void platform.reveal(folder)} title={`Show ${folder}`}>
                <FolderOpenIcon aria-hidden /> Videos\Capturely
              </button>
            )}
          </span>
        </div>
        <div className={takes?.length === 0 ? "lib-files glide hidden" : "lib-files glide"}>
          <span className="glide-pill" aria-hidden />
          <button className="btn ghost" onClick={() => void openVideo()} disabled={importing !== null} title="Open a video file to edit it here">
            <FilmIcon aria-hidden /> {importing !== null ? `Opening… ${Math.round(importing * 100)}%` : "Open video"}
          </button>
          <button className="btn ghost" onClick={() => void openProject()} title="Open a .capturely project file">
            <DocumentArrowUpIcon aria-hidden /> Open project
          </button>
        </div>
      </header>

      {!!takes?.length && (
        <div className="lib-bar">
          {selecting ? (
            <div className="lib-tools glide">
              <span className="glide-pill" aria-hidden />
              <span className="lib-count">{picked.size ? `${picked.size} selected` : "Select recordings"}</span>
              <button className="btn ghost" onClick={() => pickAll(!all)}>
                <CheckIcon aria-hidden /> {all ? "Select none" : "Select all"}
              </button>
              {confirmMany ? (
                <button className="btn danger" disabled={busy} onClick={() => void remove([...picked])} onBlur={() => setConfirmMany(false)} autoFocus>
                  <TrashIcon aria-hidden /> {busy ? "Deleting…" : `Delete ${plural(picked.size, "recording")} for good`}
                </button>
              ) : (
                <button className="btn lib-delete" disabled={!picked.size || busy} onClick={() => setConfirmMany(true)}>
                  <TrashIcon aria-hidden /> Delete{picked.size ? ` ${picked.size}` : ""}
                </button>
              )}
              <button className="btn ghost" onClick={stopSelecting}>
                <XMarkIcon aria-hidden /> Done
              </button>
            </div>
          ) : (
            <>
              <label className="lib-search">
                <MagnifyingGlassIcon aria-hidden />
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search recordings" aria-label="Search recordings" spellCheck={false} />
                {query && (
                  <button className="lib-clear" onClick={() => setQuery("")} aria-label="Clear the search" title="Clear">
                    <XMarkIcon aria-hidden />
                  </button>
                )}
              </label>
              <span className="grow" />
              <Segmented label="Order" value={sort} onChange={setSort} options={SORTS.map((s) => ({ value: s.id, label: s.label }))} />
              <div className="lib-tools glide">
                <span className="glide-pill" aria-hidden />
                <button className="btn ghost" onClick={() => setSelecting(true)}>
                  <CheckIcon aria-hidden /> Select
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}

      {takes && takes.length === 0 && (
        <section className="lib-empty" ref={empty} aria-label="No recordings yet">
          <span className="lib-empty-mark" aria-hidden>
            <i />
            <i />
            <VideoCameraIcon />
          </span>
          <h3>Your first recording starts here</h3>
          <p>Capture your screen and Capturely adds smooth zooms on every click, a polished cursor and a styled frame. Or bring in a video you already have.</p>
          <div className="lib-empty-actions glide">
            <span className="glide-pill" aria-hidden />
            <button className="rec-go" onClick={onRecord}>
              <span className="rec-go-dot" aria-hidden /> Start recording
            </button>
            <button className="btn ghost" onClick={() => void openVideo()} disabled={importing !== null}>
              <FilmIcon aria-hidden /> {importing !== null ? `Opening… ${Math.round(importing * 100)}%` : "Open a video"}
            </button>
            <button className="btn ghost" onClick={() => void openProject()}>
              <DocumentArrowUpIcon aria-hidden /> Open a project
            </button>
          </div>
          <ul className="lib-empty-points">
            <li>
              <CursorArrowRaysIcon aria-hidden /> Zooms on every click
            </li>
            <li>
              <SparklesIcon aria-hidden /> Smooth cursor
            </li>
            <li>
              <PhotoIcon aria-hidden /> Backgrounds and frames
            </li>
          </ul>
          {recordKey && (
            <span className="lib-empty-key">
              Press <kbd>{recordKey}</kbd> in any app to start
            </span>
          )}
        </section>
      )}
      {!!takes?.length && !shown.length && <p className="lib-none">No recordings match “{query.trim()}”.</p>}

      <div className={["lib-grid", selecting ? "selecting" : "", cascade ? "cascade" : ""].join(" ").trim()} ref={grid}>
        {groups.map((g) => (
          <section key={g.label} className="lib-group" aria-label={g.label}>
            <h3>
              {g.label} <span>{g.takes.length}</span>
            </h3>
            <div className="lib-cards">
              {g.takes.map((t) => {
                const on = picked.has(t.path);
                const still = thumbs[t.path] ?? t.thumb;
                const isFresh = samePath(t.path, fresh);
                const src = SOURCE[t.data?.source ?? "monitor"] ?? SOURCE.monitor;
                return (
                  <div key={t.path} data-take={t.path} className={["lib-card", isFresh ? "fresh" : "", on ? "picked" : ""].join(" ").trim()} style={{ "--i": index++ } as CSSProperties}>
                    <button className="lib-open" onClick={() => (selecting ? toggle(t.path) : onOpen(t.path))} aria-pressed={selecting ? on : undefined} aria-label={selecting ? `Select ${t.name}` : `Open ${t.name}`}>
                      <span className="lib-thumb">
                        {still ? <img src={platform.mediaUrl(still)} alt="" loading="lazy" decoding="async" draggable={false} /> : <FilmIcon className="lib-thumb-empty" aria-hidden />}
                        {!selecting && (
                          <span className="lib-play" aria-hidden>
                            <PlayIcon />
                          </span>
                        )}
                        {isFresh && !selecting && <span className="lib-new">New</span>}
                        <span className="lib-badges">
                          {t.camera && (
                            <span title="With camera">
                              <VideoCameraIcon aria-hidden />
                            </span>
                          )}
                          {t.exports.length > 0 && (
                            <span title={plural(t.exports.length, "export")}>
                              <ArrowDownTrayIcon aria-hidden /> {t.exports.length}
                            </span>
                          )}
                        </span>
                        {t.data && <span className="lib-dur">{formatTime(t.data.duration)}</span>}
                      </span>
                      <span className="lib-info">
                        <strong title={t.name}>{t.name}</strong>
                        <span className="lib-meta">
                          <src.icon aria-hidden />
                          {src.label} · {when(t.modified)} · {size(t.bytes)}
                        </span>
                      </span>
                    </button>
                    {selecting ? (
                      <span className={on ? "lib-check on" : "lib-check"} aria-hidden>
                        <CheckIcon />
                      </span>
                    ) : asking === t.path ? (
                      <button className="lib-del ask" disabled={busy} onClick={() => void remove([t.path])} onBlur={() => setAsking(null)} autoFocus title="Delete this recording and its exports">
                        <TrashIcon aria-hidden /> Delete?
                      </button>
                    ) : (
                      <button className="lib-del" onClick={() => setAsking(t.path)} aria-label={`Delete ${t.name}`} title="Delete">
                        <TrashIcon aria-hidden />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

type Sort = "newest" | "oldest" | "longest" | "largest" | "name";
const SORTS: ReadonlyArray<{ id: Sort; label: string }> = [
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "longest", label: "Longest" },
  { id: "largest", label: "Largest" },
  { id: "name", label: "Name" },
];
const SORT_KEY = "capturely.librarySort";
function loadSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    return SORTS.some((s) => s.id === v) ? (v as Sort) : "newest";
  } catch {
    return "newest";
  }
}

function sortTakes(list: TakeInfo[], sort: Sort): TakeInfo[] {
  const by: Record<Sort, (a: TakeInfo, b: TakeInfo) => number> = {
    newest: (a, b) => b.modified - a.modified,
    oldest: (a, b) => a.modified - b.modified,
    longest: (a, b) => (b.data?.duration ?? 0) - (a.data?.duration ?? 0),
    largest: (a, b) => b.bytes - a.bytes,
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  };
  return [...list].sort(by[sort]);
}

/** Takes in date groups, in the order given: Today, Yesterday, This week, then by month. */
function groupByDay(list: TakeInfo[]): Array<{ label: string; takes: TakeInfo[] }> {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = day(new Date());
  const label = (ms: number) => {
    const d = new Date(ms);
    const ago = Math.round((today - day(d)) / 86_400_000);
    if (ago <= 0) return "Today";
    if (ago === 1) return "Yesterday";
    if (ago < 7) return "This week";
    return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  };
  const out: Array<{ label: string; takes: TakeInfo[] }> = [];
  for (const t of list) {
    const l = label(t.modified);
    const g = out.find((x) => x.label === l);
    if (g) g.takes.push(t);
    else out.push({ label: l, takes: [t] });
  }
  return out;
}

/** When a take was last changed: the time today, else the date. */
function when(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
}

const SOURCE: Record<TakeData["source"], { label: string; icon: typeof FilmIcon }> = {
  monitor: { label: "Screen", icon: ComputerDesktopIcon },
  window: { label: "Window", icon: WindowIcon },
  area: { label: "Area", icon: ViewfinderCircleIcon },
  import: { label: "Video file", icon: FilmIcon },
};
