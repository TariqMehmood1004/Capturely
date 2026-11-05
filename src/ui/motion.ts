// Motion settings (GSAP) and the reduced-motion rule: with "reduce motion" set in Windows nothing
// moves, and on very weak computers (2 cores or 2 GB or less) neither, so the app stays quick.
export const MOTION = { fast: 0.2, base: 0.45, stagger: 0.03, ease: "power3.out", rise: 14 } as const;

const weak = (() => {
  const n = navigator as Navigator & { deviceMemory?: number };
  return (n.hardwareConcurrency > 0 && n.hardwareConcurrency <= 2) || (typeof n.deviceMemory === "number" && n.deviceMemory <= 2);
})();

export const reducedMotion = (): boolean => {
  if (weak) return true;
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
