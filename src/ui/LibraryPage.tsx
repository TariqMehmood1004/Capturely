import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { errorMessage, platform, type TakeInfo } from "../platform";
import { CheckIcon, FilmIcon, TrashIcon, XMarkIcon } from "./icons";
import { formatTime, MOTION, reducedMotion } from "./motion";

const samePath = (a: string, b?: string | null) => !!b && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Every recording in Videos\ReeliF Capture, newest first; `fresh` (just recorded) is marked.
 * Each card has a delete button (press twice: it asks first). "Select" picks several, or all, to
 * delete together.
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
  const pickAll = (on: boolean) => {
    if (!takes) return;
    window.clearTimeout(cascadeTimer.current);
    setCascade(true);
    setPicked(on ? new Set(takes.map((t) => t.path)) : new Set());
    cascadeTimer.current = window.setTimeout(() => setCascade(false), 450 + takes.length * 45);
  };
  useEffect(() => () => window.clearTimeout(cascadeTimer.current), []);
  const animated = useRef(false);

  useEffect(() => {
    platform
      .library()
      .then(setTakes)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  // The cards rise in once (not again after a delete).
  useLayoutEffect(() => {
    if (!grid.current || !takes?.length || animated.current || reducedMotion()) return;
    animated.current = true;
    gsap.fromTo(grid.current.children, { y: MOTION.rise, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: MOTION.base, ease: MOTION.ease, stagger: MOTION.stagger, clearProps: "transform,opacity,visibility" });
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

  const all = !!takes?.length && picked.size === takes.length;

  return (
    <div className="page">
      <div className="lib-head">
        <h2>Library</h2>
        <span className="muted-note">{takes ? `${plural(takes.length, "recording")} in Videos\\ReeliF Capture` : ""}</span>
        <span className="grow" />
        {!!takes?.length && (
          <div className="lib-tools glide">
            <span className="glide-pill" aria-hidden />
            {selecting ? (
              <>
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
              </>
            ) : (
              <button className="btn ghost" onClick={() => setSelecting(true)}>
                <CheckIcon aria-hidden /> Select
              </button>
            )}
          </div>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {takes && takes.length === 0 && (
        <div className="lib-empty">
          <FilmIcon aria-hidden />
          <strong>No recordings yet</strong>
          <button className="rec-go" onClick={onRecord}>
            <span className="rec-go-dot" aria-hidden /> Make your first recording
          </button>
        </div>
      )}
      <div className={["lib-grid", selecting ? "selecting" : "", cascade ? "cascade" : ""].join(" ").trim()} ref={grid}>
        {takes?.map((t, i) => {
          const on = picked.has(t.path);
          return (
            <div key={t.path} data-take={t.path} className={["lib-card", samePath(t.path, fresh) ? "fresh" : "", on ? "picked" : ""].join(" ").trim()} style={{ "--i": i } as CSSProperties}>
              <button className="lib-open" onClick={() => (selecting ? toggle(t.path) : onOpen(t.path))} aria-pressed={selecting ? on : undefined} aria-label={selecting ? `Select ${t.name}` : `Open ${t.name}`}>
                <span className="lib-thumb">
                  {t.video && <video src={`${platform.mediaUrl(t.video)}#t=1`} preload="metadata" muted />}
                  {samePath(t.path, fresh) && !selecting && <span className="lib-new">New</span>}
                </span>
                <strong>{t.name}</strong>
                <span className="muted-note">
                  {t.data ? formatTime(t.data.duration) : "—"} · {size(t.bytes)}
                  {t.exports.length ? ` · ${plural(t.exports.length, "export")}` : ""}
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
    </div>
  );
}
