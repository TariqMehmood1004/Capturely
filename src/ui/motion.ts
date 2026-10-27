// Motion settings (GSAP) and the reduced-motion rule: with "reduce motion" set in Windows nothing moves.
export const MOTION = { fast: 0.2, base: 0.45, stagger: 0.03, ease: "power3.out", rise: 14 } as const;

export const reducedMotion = (): boolean => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

export const formatTime = (s: number): string => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const r = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};
