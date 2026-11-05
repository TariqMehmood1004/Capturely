// Dark or light, as in ReeliF Studio: until one is chosen the app follows Windows; a choice is
// kept on this computer and set as data-theme on <html> in every window. Changing it reveals the
// new look with a circle growing from the switch (View Transitions); reduced motion switches at
// once, and without View Transitions the colours cross-fade.
import { reducedMotion } from "./motion";

export type Theme = "dark" | "light";
const KEY = "reelifcapture.theme";

export const systemTheme = (): Theme => (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

/** The chosen theme, or null while the app follows Windows. */
export function chosenTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

export function saveTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* applied for now, not remembered */
  }
}

const shown = (): Theme => {
  const v = document.documentElement.dataset.theme;
  return v === "dark" || v === "light" ? v : systemTheme();
};

/** Set the theme on this window; `origin` (viewport point) reveals it from there, "fade"
 *  cross-fades the colours (a change made in another window). */
export function applyTheme(t: Theme | null, origin?: { x: number; y: number } | "fade") {
  const root = document.documentElement;
  const set = () => {
    if (t) root.dataset.theme = t;
    else delete root.dataset.theme;
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  if (!origin || reducedMotion() || (t ?? systemTheme()) === shown()) return set();
  if (origin === "fade" || !doc.startViewTransition || document.visibilityState === "hidden") {
    root.classList.add("theme-fading");
    set();
    window.setTimeout(() => root.classList.remove("theme-fading"), 400);
    return;
  }
  const { x, y } = origin;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  doc
    .startViewTransition(set)
    .ready.then(() => {
      // The new look grows out of the switch over the old one, which stays still underneath.
      root.animate([{ clipPath: `circle(0px at ${x}px ${y}px)` }, { clipPath: `circle(${r}px at ${x}px ${y}px)` }], { duration: 560, easing: "cubic-bezier(0.65, 0, 0.25, 1)", fill: "both", pseudoElement: "::view-transition-new(root)" });
    })
    .catch(() => undefined);
}
