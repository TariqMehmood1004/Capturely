// Design frame for screen recordings: the picture sits on a background with padding, rounded
// corners and a soft shadow. The background is a preset, a colour, a gradient, or a picture (a
// built-in wallpaper, one from the Wallpapers folder, or one added to the take), optionally
// blurred. Export (FFmpeg graph) and preview (CSS) are built from the same numbers here. Pure.

export interface ScreenFrame {
  /** A preset id (FRAME_BACKGROUNDS), or "color" / "gradient" / "image" for the fields below. */
  background: string;
  color?: string;
  /** Gradient colours and direction (CSS degrees: 0 = upwards, 90 = to the right). */
  from?: string;
  to?: string;
  angle?: number;
  /** A picture: "builtin:<id>", "wallpaper:<file name>" or "media:<file name>" (the take's own). */
  image?: string;
  /** Blur of a picture background, 0 .. 1. */
  blur?: number;
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

/** Wallpapers built into the app (src/assets/wallpapers, scripts/make-wallpapers.py). */
export const BUILTIN_WALLPAPERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "aurora", label: "Aurora" },
  { id: "lagoon", label: "Lagoon" },
  { id: "ember", label: "Ember" },
  { id: "meadow", label: "Meadow" },
  { id: "nebula", label: "Nebula" },
  { id: "dune", label: "Dune" },
];

export const DEFAULT_FRAME: ScreenFrame = { background: "violet", padding: 0.06, radius: 0.025, shadow: 0.6 };
/** Bars around a picture of another shape when there is no frame. */
export const PLAIN_FRAME: ScreenFrame = { background: "color", color: "#000000", padding: 0, radius: 0, shadow: 0 };

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
/** A picture reference: a known kind and a plain file name (no folders). */
export const isImageRef = (v: unknown): v is string => typeof v === "string" && /^(builtin|wallpaper|media):[^\\/:*?"<>|]{1,120}$/.test(v) && !v.includes("..");

export function validFrame(v: unknown): ScreenFrame | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const base = {
    padding: clamp(o.padding, 0, 0.2, DEFAULT_FRAME.padding),
    radius: clamp(o.radius, 0, 0.1, DEFAULT_FRAME.radius),
    shadow: clamp(o.shadow, 0, 1, DEFAULT_FRAME.shadow),
  };
  if (o.background === "color" && isHex(o.color)) return { background: "color", color: o.color.toLowerCase(), ...base };
  if (o.background === "gradient" && isHex(o.from) && isHex(o.to)) return { background: "gradient", from: o.from.toLowerCase(), to: o.to.toLowerCase(), angle: clamp(o.angle, 0, 360, 135), ...base };
  if (o.background === "image" && isImageRef(o.image)) return { background: "image", image: o.image, blur: clamp(o.blur, 0, 1, 0), ...base };
  return { background: FRAME_BACKGROUNDS.some((b) => b.id === o.background) ? (o.background as string) : DEFAULT_FRAME.background, ...base };
}

export const backgroundOf = (f: ScreenFrame): FrameBackground => FRAME_BACKGROUNDS.find((b) => b.id === f.background) ?? FRAME_BACKGROUNDS[0]!;

/** The background as colours: one (plain), two with an angle (gradient), or null for a picture. */
export function paintOf(f: ScreenFrame): { from: string; to: string; angle: number } | null {
  if (f.background === "image") return null;
  if (f.background === "color") return { from: f.color ?? "#000000", to: f.color ?? "#000000", angle: 135 };
  if (f.background === "gradient") return { from: f.from ?? "#000000", to: f.to ?? "#000000", angle: f.angle ?? 135 };
  const b = backgroundOf(f);
  return { from: b.from, to: b.to, angle: 135 };
}

/** The gradient line of a CSS `linear-gradient(<angle>)` over a W×H box, as two points. */
export function gradientLine(angle: number, W: number, H: number): { x0: number; y0: number; x1: number; y1: number } {
  const a = (angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(W * dx) + Math.abs(H * dy)) / 2;
  const r = (v: number) => Math.round(v);
  return { x0: r(W / 2 - dx * half), y0: r(H / 2 - dy * half), x1: r(W / 2 + dx * half), y1: r(H / 2 + dy * half) };
}

/** Blur strength of a picture background in pixels for a W×H video. */
export const blurSigma = (f: ScreenFrame, W: number, H: number): number => (f.blur ?? 0) * Math.min(W, H) * 0.025;

/** Inside a rounded rectangle of its own size (W, H) with corner radius r: 255, else 0 (FFmpeg geq). */
export const roundedMask = (r: number): string => (r > 0 ? `255*lte(hypot(max(max(${r}-X,X-(W-1-${r})),0),max(max(${r}-Y,Y-(H-1-${r})),0)),${r})` : "255");

/** A still, drawn once and repeated, as a stream at `fps` (cheap per frame). */
export const stillMask = (expr: string, w: number, h: number, fps: number): string => `color=c=black:s=${w}x${h}:r=${fps}:d=${(1 / fps).toFixed(4)},format=gray,geq=lum='${expr}',loop=loop=-1:size=1,setpts=N/${fps}/TB`;

/**
 * FFmpeg chains putting `from` (the finished picture) into a W×H video at `box`; returns the new
 * label. `image` is the input number of a picture background. The rounded-corner mask and the
 * shadow are drawn once and repeated, so the cost per frame is a scale and a few overlays.
 */
export function frameChains(chains: string[], f: ScreenFrame, out: { width: number; height: number }, box: { x: number; y: number; w: number; h: number; radius: number }, fps: number, from: string, image?: number): string {
  const { width: W, height: H } = out;
  const { x, y, w, h, radius: r } = box;
  const hex = (c: string) => `0x${c.slice(1)}`;
  const paint = paintOf(f);
  if (paint) {
    const g = gradientLine(paint.angle, W, H);
    chains.push(paint.from === paint.to ? `color=c=${hex(paint.from)}:s=${W}x${H}:r=${fps}[fbg]` : `gradients=s=${W}x${H}:r=${fps}:c0=${hex(paint.from)}:c1=${hex(paint.to)}:x0=${g.x0}:y0=${g.y0}:x1=${g.x1}:y1=${g.y1}:speed=0:n=2[fbg]`);
  } else {
    const s = blurSigma(f, W, H);
    chains.push(`[${image ?? 1}:v]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}${s > 0.3 ? `,gblur=sigma=${s.toFixed(2)}` : ""},format=yuv420p,loop=loop=-1:size=1,setpts=N/${fps}/TB[fbg]`);
  }
  chains.push(`${stillMask(roundedMask(r), w, h, fps)}[fmask]`);
  chains.push(`${from}scale=${w}:${h}:flags=lanczos,format=yuva420p[fpic]`, `[fpic][fmask]alphamerge[fround]`);
  let base = "[fbg]";
  if (f.shadow > 0.01) {
    const m = Math.round(Math.min(W, H) * 0.04);
    const sigma = (m / 2.5).toFixed(2);
    chains.push(
      `${stillMask(roundedMask(r), w, h, fps)},pad=${w + 2 * m}:${h + 2 * m}:${m}:${m}:black,gblur=sigma=${sigma}[fsm]`,
      `color=c=black:s=${w + 2 * m}x${h + 2 * m}:r=${fps},format=yuva420p[fsc]`,
      `[fsc][fsm]alphamerge,colorchannelmixer=aa=${(0.75 * f.shadow).toFixed(3)}[fsh]`,
      `[fbg][fsh]overlay=x=${x - m}:y=${y - m + Math.round(m * 0.4)}[fbs]`,
    );
    base = "[fbs]";
  }
  chains.push(`${base}[fround]overlay=x=${x}:y=${y}:shortest=1,format=yuv420p[fframe]`);
  return "[fframe]";
}

/**
 * The preview's CSS for the same frame: the background layer and the picture's box, as shares of
 * the stage (`box` and `out` from core/style.ts layout). `url` turns a picture reference into
 * something the page can show.
 */
export function frameCss(f: ScreenFrame, out: { width: number; height: number }, box: { x: number; y: number; w: number; h: number; radius: number }, url: (ref: string) => string): { bg: Record<string, string>; picture: Record<string, string> } {
  const paint = paintOf(f);
  const short = Math.min(out.width, out.height);
  // Blur in the stage's own units: container query units scale with it like the export does.
  const cq = (px: number) => `${((px / out.width) * 100).toFixed(3)}cqi`;
  const bg: Record<string, string> = paint
    ? { background: paint.from === paint.to ? paint.from : `linear-gradient(${paint.angle}deg, ${paint.from}, ${paint.to})` }
    : { backgroundImage: `url("${url(f.image ?? "")}")`, backgroundSize: "cover", backgroundPosition: "center", filter: (f.blur ?? 0) > 0.01 ? `blur(${cq(blurSigma(f, out.width, out.height))})` : "none", inset: (f.blur ?? 0) > 0.01 ? `-${cq(blurSigma(f, out.width, out.height) * 3)}` : "0" };
  const m = short * 0.04;
  return {
    bg,
    picture: {
      position: "absolute",
      left: `${(box.x / out.width) * 100}%`,
      top: `${(box.y / out.height) * 100}%`,
      width: `${(box.w / out.width) * 100}%`,
      height: `${(box.h / out.height) * 100}%`,
      borderRadius: cq(box.radius),
      boxShadow: f.shadow > 0.01 ? `0 ${cq(m * 0.4)} ${cq(m * 2)} rgba(0,0,0,${0.75 * f.shadow})` : "none",
    },
  };
}
