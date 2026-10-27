// Custom form controls (switch, segmented radio, slider, swatches): flat surfaces, the accent for
// what is chosen, keyboard and screen-reader friendly. Motion with GSAP, none under reduced motion.
import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { reducedMotion } from "./motion";

export function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={on ? "ui-switch on" : "ui-switch"} onClick={() => onChange(!on)}>
      <i aria-hidden />
    </button>
  );
}

/** A radio group drawn as one track with a highlight that glides to the chosen option. */
export function Segmented<T extends string | number>({ value, options, label, onChange, wide }: { value: T; options: ReadonlyArray<{ value: T; label: string; sub?: string }>; label: string; onChange: (v: T) => void; wide?: boolean }) {
  const box = useRef<HTMLDivElement | null>(null);
  const pill = useRef<HTMLSpanElement | null>(null);
  const first = useRef(true);
  const at = Math.max(0, options.findIndex((o) => o.value === value));

  useLayoutEffect(() => {
    const btn = box.current?.querySelectorAll<HTMLElement>("button")[at];
    if (!btn || !pill.current) return;
    const to = { x: btn.offsetLeft, width: btn.offsetWidth };
    if (first.current || reducedMotion()) gsap.set(pill.current, to);
    else gsap.to(pill.current, { ...to, duration: 0.3, ease: "power3.out" });
    first.current = false;
  }, [at, options.length, options.map((o) => o.sub ?? "").join()]);

  const key = (e: KeyboardEvent) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = (at + d + options.length) % options.length;
    onChange(options[next]!.value);
    box.current?.querySelectorAll<HTMLElement>("button")[next]?.focus();
  };

  return (
    <div className={wide ? "ui-seg wide" : "ui-seg"} role="radiogroup" aria-label={label} ref={box} onKeyDown={key}>
      <span className="ui-seg-pill" ref={pill} aria-hidden />
      {options.map((o, i) => (
        <button key={String(o.value)} role="radio" aria-checked={i === at} tabIndex={i === at ? 0 : -1} className={[i === at ? "on" : "", o.sub ? "two" : ""].join(" ").trim()} onClick={() => onChange(o.value)}>
          {o.label}
          {o.sub && <small>{o.sub}</small>}
        </button>
      ))}
    </div>
  );
}

/** A slider: drag anywhere on the track, arrows/Page/Home/End on the keyboard. */
export function Slider({ label, value, min, max, step, format, onChange }: { label: string; value: number; min: number; max: number; step: number; format: (v: number) => string; onChange: (v: number) => void }) {
  const track = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState(false);
  const snap = (v: number) => {
    const s = Math.round((Math.min(max, Math.max(min, v)) - min) / step) * step + min;
    return Number(s.toFixed(6));
  };
  const frac = (value - min) / (max - min || 1);
  const fromPointer = (e: PointerEvent) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return;
    onChange(snap(min + ((e.clientX - r.left) / r.width) * (max - min)));
  };
  const key = (e: KeyboardEvent) => {
    const big = step * 10;
    const next = { ArrowRight: value + step, ArrowUp: value + step, ArrowLeft: value - step, ArrowDown: value - step, PageUp: value + big, PageDown: value - big, Home: min, End: max }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    onChange(snap(next));
  };

  return (
    <div className="ui-slider">
      <span className="ui-slider-label">{label}</span>
      <div
        ref={track}
        className={drag ? "ui-track drag" : "ui-track"}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={format(value)}
        style={{ "--f": frac } as CSSProperties}
        onKeyDown={key}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus();
          setDrag(true);
          fromPointer(e);
        }}
        onPointerMove={(e) => drag && fromPointer(e)}
        onPointerUp={() => setDrag(false)}
        onPointerCancel={() => setDrag(false)}
      >
        <i className="ui-fill" aria-hidden />
        <i className="ui-thumb" aria-hidden />
      </div>
      <output className="ui-slider-value">{format(value)}</output>
    </div>
  );
}

/** Colour choices as round swatches (a radio group). */
export function Swatches({ value, options, label, onChange }: { value: string; options: ReadonlyArray<{ id: string; label: string; paint: string }>; label: string; onChange: (id: string) => void }) {
  return (
    <div className="ui-swatches" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} aria-label={o.label} title={o.label} className={value === o.id ? "ui-swatch on" : "ui-swatch"} onClick={() => onChange(o.id)}>
          <i style={{ background: o.paint }} aria-hidden />
        </button>
      ))}
    </div>
  );
}

/**
 * A dropdown panel under its trigger (as in ReeliF Studio's menus): drops in with a short scale
 * and rise, its contents follow; closes on Escape or a press outside.
 */
export function Dropdown({ label, align = "end", width, trigger, children }: { label: string; align?: "start" | "end"; width?: number; trigger: (p: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const down = (e: globalThis.PointerEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const key = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);

  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el || reducedMotion()) return;
    gsap.fromTo(el, { autoAlpha: 0, y: -6, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.2, ease: "power2.out", transformOrigin: align === "end" ? "top right" : "top left", clearProps: "transform" });
    gsap.fromTo(el.querySelectorAll(":scope > *"), { y: -4, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.22, ease: "power2.out", stagger: 0.02, clearProps: "transform,opacity,visibility" });
  }, [open, align]);

  return (
    <div className="ui-drop" ref={wrap}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div className={`ui-pop ${align}`} ref={pop} role="dialog" aria-label={label} style={width ? { width } : undefined}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
