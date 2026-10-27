// Design frame for screen recordings (Recordly-style): the picture sits on a background with
// padding, rounded corners and a soft shadow. Export (FFmpeg graph) and preview (CSS) are built
// from the same numbers here. Pure.

export interface ScreenFrame {
  /** Background preset id (FRAME_BACKGROUNDS). */
  background: string;
  /** Space around the picture, 0 .. 0.2 of each side. */
  padding: number;
  /** Corner radius, 0 .. 0.1 of the picture's shorter side. */
  radius: number;
  /** Shadow strength 0 (none) .. 1. */
  shadow: number;
}

export interface FrameBackground {
  id: string;
  label: string;
  /** Two colours; equal for a plain colour. Drawn diagonally (top left -> bottom right). */
  from: string;
  to: string;
}

export const FRAME_BACKGROUNDS: readonly FrameBackground[] = [
  { id: "violet", label: "Violet", from: "#6d28d9", to: "#db2777" },
  { id: "ocean", label: "Ocean", from: "#0ea5e9", to: "#4f46e5" },
  { id: "sunset", label: "Sunset", from: "#f97316", to: "#e11d48" },
  { id: "mint", label: "Mint", from: "#10b981", to: "#0e7490" },
  { id: "dusk", label: "Dusk", from: "#1e293b", to: "#7c3aed" },
  { id: "sand", label: "Sand", from: "#fde68a", to: "#f59e0b" },
  { id: "graphite", label: "Graphite", from: "#18181b", to: "#18181b" },
  { id: "white", label: "White", from: "#f4f4f5", to: "#f4f4f5" },
];

export const DEFAULT_FRAME: ScreenFrame = { background: "violet", padding: 0.06, radius: 0.025, shadow: 0.6 };

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function validFrame(v: unknown): ScreenFrame | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  return {
    background: FRAME_BACKGROUNDS.some((b) => b.id === o.background) ? (o.background as string) : DEFAULT_FRAME.background,
    padding: clamp(o.padding, 0, 0.2, DEFAULT_FRAME.padding),
    radius: clamp(o.radius, 0, 0.1, DEFAULT_FRAME.radius),
    shadow: clamp(o.shadow, 0, 1, DEFAULT_FRAME.shadow),
  };
}

export const backgroundOf = (f: ScreenFrame): FrameBackground => FRAME_BACKGROUNDS.find((b) => b.id === f.background) ?? FRAME_BACKGROUNDS[0]!;

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Picture size inside the frame (same shape as the output, so nothing is stretched). */
export function frameInner(f: ScreenFrame, out: { width: number; height: number }): { w: number; h: number; radius: number } {
  const w = even(out.width * (1 - 2 * f.padding));
  const h = even(out.height * (1 - 2 * f.padding));
  return { w, h, radius: Math.round(f.radius * Math.min(w, h)) };
}

/**
 * FFmpeg chains putting `from` (the finished main picture, W x H) into the frame; returns the new
 * label. The rounded-corner mask and the shadow are drawn once and repeated, so the cost per frame
 * is two scales and three overlays.
 */
export function frameChains(chains: string[], f: ScreenFrame, out: { width: number; height: number }, fps: number, from: string): string {
  const { width: W, height: H } = out;
  const { w, h, radius: r } = frameInner(f, out);
  const bg = backgroundOf(f);
  const hex = (c: string) => `0x${c.slice(1)}`;
  const source =
    bg.from === bg.to
      ? `color=c=${hex(bg.from)}:s=${W}x${H}:r=${fps}`
      : `gradients=s=${W}x${H}:r=${fps}:c0=${hex(bg.from)}:c1=${hex(bg.to)}:x0=0:y0=0:x1=${W}:y1=${H}:speed=0:n=2`;
  const still = (expr: string, sw: number, sh: number) => `color=c=black:s=${sw}x${sh}:r=${fps}:d=${(1 / fps).toFixed(4)},format=gray,geq=lum='${expr}',loop=loop=-1:size=1,setpts=N/${fps}/TB`;
  // Inside the rounded rectangle (W, H here are the mask's own size).
  const inside = r > 0 ? `255*lte(hypot(max(max(${r}-X,X-(W-1-${r})),0),max(max(${r}-Y,Y-(H-1-${r})),0)),${r})` : "255";
  chains.push(`${source}[fbg]`);
  chains.push(`${still(inside, w, h)}[fmask]`);
  chains.push(`${from}scale=${w}:${h}:flags=lanczos,format=yuva420p[fpic]`, `[fpic][fmask]alphamerge[fround]`);
  let base = "[fbg]";
  if (f.shadow > 0.01) {
    const m = Math.round(Math.min(W, H) * 0.04);
    const sigma = (m / 2.5).toFixed(2);
    chains.push(
      `${still(inside, w, h)},pad=${w + 2 * m}:${h + 2 * m}:${m}:${m}:black,gblur=sigma=${sigma}[fsm]`,
      `color=c=black:s=${w + 2 * m}x${h + 2 * m}:r=${fps},format=yuva420p[fsc]`,
      `[fsc][fsm]alphamerge,colorchannelmixer=aa=${(0.75 * f.shadow).toFixed(3)}[fsh]`,
      `[fbg][fsh]overlay=x=(W-w)/2:y=(H-h)/2+${Math.round(m * 0.4)}[fbs]`,
    );
    base = "[fbs]";
  }
  chains.push(`${base}[fround]overlay=x=(W-w)/2:y=(H-h)/2:shortest=1,format=yuv420p[fframe]`);
  return "[fframe]";
}

/** The preview's CSS for the same frame: the stage's background and the picture's box. `short` is a
 * CSS length equal to the stage's shorter side (e.g. in container units). */
export function frameCss(f: ScreenFrame, short: string): { stage: Record<string, string>; picture: Record<string, string> } {
  const bg = backgroundOf(f);
  const inner = 1 - 2 * f.padding;
  return {
    stage: { background: bg.from === bg.to ? bg.from : `linear-gradient(135deg, ${bg.from}, ${bg.to})` },
    picture: {
      width: `${inner * 100}%`,
      height: `${inner * 100}%`,
      left: `${f.padding * 100}%`,
      top: `${f.padding * 100}%`,
      borderRadius: `calc(${f.radius * inner} * ${short})`,
      boxShadow: f.shadow > 0.01 ? `0 calc(0.016 * ${short}) calc(0.08 * ${short}) rgba(0,0,0,${0.75 * f.shadow})` : "none",
    },
  };
}
