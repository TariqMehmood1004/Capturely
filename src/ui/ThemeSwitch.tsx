import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { platform } from "../platform";
import { MoonIcon, SunIcon } from "./icons";
import { reducedMotion } from "./motion";
import { applyTheme, chosenTheme, saveTheme, systemTheme, type Theme } from "./theme";

const THEMES: ReadonlyArray<{ id: Theme; label: string; icon: typeof SunIcon }> = [
  { id: "dark", label: "Dark theme", icon: MoonIcon },
  { id: "light", label: "Light theme", icon: SunIcon },
];

/** Title bar switch (as in ReeliF Studio): dark or light; the highlight glides, the icon turns in. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => chosenTheme() ?? systemTheme());
  const box = useRef<HTMLDivElement | null>(null);
  const pill = useRef<HTMLSpanElement | null>(null);
  const first = useRef(true);

  // Follows Windows until a theme is chosen, and changes made in another window.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sys = () => !chosenTheme() && setTheme(systemTheme());
    mq.addEventListener("change", sys);
    let off: (() => void) | null = null;
    void platform.theme.onChange(setTheme).then((u) => (off = u));
    return () => {
      mq.removeEventListener("change", sys);
      off?.();
    };
  }, []);

  useLayoutEffect(() => {
    const btn = box.current?.querySelector<HTMLElement>(`[data-theme-id="${theme}"]`);
    if (!btn || !pill.current) return;
    const to = { x: btn.offsetLeft, width: btn.offsetWidth };
    if (first.current || reducedMotion()) gsap.set(pill.current, to);
    else gsap.to(pill.current, { ...to, duration: 0.32, ease: "power3.out" });
    first.current = false;
  }, [theme]);

  const pick = (t: Theme, el: HTMLElement) => {
    if (t === theme) return;
    const r = el.getBoundingClientRect();
    saveTheme(t);
    setTheme(t);
    applyTheme(t, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
    platform.theme.send(t);
  };

  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme" ref={box}>
      <span className="ui-seg-pill" ref={pill} aria-hidden />
      {THEMES.map((t) => (
        <button key={t.id} data-theme-id={t.id} role="radio" aria-checked={theme === t.id} aria-label={t.label} title={t.label} className={theme === t.id ? "theme-btn on" : "theme-btn"} onClick={(e) => pick(t.id, e.currentTarget)}>
          <t.icon aria-hidden />
        </button>
      ))}
    </div>
  );
}
