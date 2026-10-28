import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { platform, type AreaRect } from "../platform";
import { ViewfinderCircleIcon, XMarkIcon } from "./icons";
import { reducedMotion } from "./motion";

/** Smaller boxes than this (CSS pixels) are not offered for recording. */
const MIN = 64;

type Box = { x: number; y: number; w: number; h: number };

/**
 * The area picker (window "picker"): covers one screen, dimmed. Drag out a box; Enter or "Record
 * this area" sends it (physical pixels from the screen's corner) to the bar, Esc cancels.
 * Dragging again draws a new box.
 */
export default function Picker() {
  const [box, setBox] = useState<Box | null>(null);
  const [drawing, setDrawing] = useState(false);
  const from = useRef<{ x: number; y: number } | null>(null);
  const tools = useRef<HTMLDivElement | null>(null);
  const hint = useRef<HTMLDivElement | null>(null);
  const ok = !!box && box.w >= MIN && box.h >= MIN;
  const dpr = window.devicePixelRatio || 1;

  const finish = (area: AreaRect | null) => {
    platform.picker.done(area);
    void platform.picker.close();
  };
  const confirm = () => {
    if (!box || !ok) return;
    finish({ x: Math.round(box.x * dpr), y: Math.round(box.y * dpr), width: Math.round(box.w * dpr), height: Math.round(box.h * dpr) });
  };
  const keys = useRef({ confirm, finish });
  keys.current = { confirm, finish };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") keys.current.finish(null);
      else if (e.key === "Enter") keys.current.confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useLayoutEffect(() => {
    if (!hint.current || reducedMotion()) return;
    gsap.fromTo(hint.current, { y: -12, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.35, ease: "power3.out" });
  }, []);
  // The buttons rise in once a box is drawn.
  useLayoutEffect(() => {
    if (drawing || !ok || !tools.current || reducedMotion()) return;
    gsap.fromTo(tools.current, { y: 8, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.25, ease: "power3.out" });
  }, [drawing, ok]);

  const down = (e: ReactPointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".pk-tools")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    from.current = { x: e.clientX, y: e.clientY };
    setBox({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    setDrawing(true);
  };
  const move = (e: ReactPointerEvent) => {
    const f = from.current;
    if (!f || !drawing) return;
    const x = Math.max(0, Math.min(f.x, e.clientX));
    const y = Math.max(0, Math.min(f.y, e.clientY));
    setBox({ x, y, w: Math.min(window.innerWidth, Math.max(f.x, e.clientX)) - x, h: Math.min(window.innerHeight, Math.max(f.y, e.clientY)) - y });
  };
  const up = () => {
    from.current = null;
    setDrawing(false);
  };

  // The buttons sit under the box, or above it when the box reaches the bottom.
  const below = box ? box.y + box.h + 56 < window.innerHeight : true;
  return (
    <div className={box ? "pk has-box" : "pk"} onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      {box && box.w > 0 && (
        <div className="pk-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
          <span className="pk-size">
            {Math.round(box.w * dpr)} × {Math.round(box.h * dpr)}
          </span>
        </div>
      )}
      {!box && (
        <div className="pk-hint" ref={hint}>
          <ViewfinderCircleIcon aria-hidden />
          <span>
            <strong>Drag to choose the area to record</strong>
            <em>Enter records it · Esc cancels</em>
          </span>
        </div>
      )}
      {box && !drawing && ok && (
        <div className="pk-tools" ref={tools} style={{ left: box.x + box.w / 2, top: below ? box.y + box.h + 12 : box.y - 52 }}>
          <button className="btn ghost" onClick={() => finish(null)}>
            <XMarkIcon aria-hidden /> Cancel
          </button>
          <button className="btn primary" onClick={confirm} autoFocus>
            <ViewfinderCircleIcon aria-hidden /> Record this area
          </button>
        </div>
      )}
      {box && !drawing && !ok && <div className="pk-hint small">Too small: drag out a bigger box</div>}
    </div>
  );
}
