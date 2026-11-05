// Marks added in the editor: blur, text, pictures and shapes (rectangle, ellipse, arrow). A blur
// covers part of the recording (it zooms with it); the others sit on the finished video (they
// stay put). Each shows between two moments of the recording. Positions and sizes are 0..1 of
// their picture. Shapes are drawn as SVG, the same for the preview and the export. Pure.
import { isImageRef } from "./frame";

export type ShapeKind = "rect" | "ellipse" | "arrow";
export const SHAPES: ReadonlyArray<{ id: ShapeKind; label: string }> = [
  { id: "rect", label: "Box" },
  { id: "ellipse", label: "Circle" },
  { id: "arrow", label: "Arrow" },
];
export const SHAPE_COLORS = ["#f43f5e", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111827"] as const;

export interface Mark {
  id: string;
  kind: "blur" | "text" | "image" | "shape";
  /** Shown from `a` to `b` (recording seconds). */
  a: number;
  b: number;
  /** The box; an arrow runs from (x, y) to (x + w, y + h), so its w and h can be negative. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text labels: the words and the letter height as a share of the video's height. */
  text?: string;
  size?: number;
  /** Pictures: the take's file ("media:<name>"). */
  file?: string;
  /** Shapes: which, the colour, line width (share of the video's height), filled or outlined. */
  shape?: ShapeKind;
  color?: string;
  stroke?: number;
  fill?: boolean;
}

export const TEXT_SIZE = 0.045;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);

/** A new mark at `t`, in the middle, shown for `len` seconds (to the end at most). */
export function newMark(kind: Mark["kind"], t: number, duration: number, len = 3, extra: Partial<Mark> = {}): Mark {
  const a = clamp(t, 0, Math.max(0, duration - 0.5));
  const place: Record<Mark["kind"], Partial<Mark>> = {
    blur: { x: 0.35, y: 0.35, w: 0.3, h: 0.12 },
    text: { x: 0.06, y: 0.84, w: 0, h: 0, text: "Your text", size: TEXT_SIZE },
    image: { x: 0.38, y: 0.3, w: 0.24, h: 0.24 },
    shape: { x: 0.35, y: 0.3, w: 0.3, h: 0.25, shape: "rect", color: SHAPE_COLORS[0], stroke: 0.008, fill: false },
  };
  return fitMark(
    {
      id: `${kind}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
      kind,
      a: r4(a),
      b: r4(Math.min(duration, a + len)),
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      ...place[kind],
      ...extra,
    },
    duration,
  );
}

/** Keep a mark on its picture and its times in order. */
export function fitMark(m: Mark, duration: number): Mark {
  const a = clamp(Math.min(m.a, m.b), 0, duration);
  const b = clamp(Math.max(m.a, m.b), a + 0.1, Math.max(a + 0.1, duration));
  const times = { a: r4(a), b: r4(b) };
  if (m.kind === "text") return { ...m, ...times, w: 0, h: 0, x: r4(clamp(m.x, 0, 1)), y: r4(clamp(m.y, 0, 1)), text: (m.text ?? "").replace(/\s*\n\s*/g, " ").slice(0, 120), size: clamp(m.size ?? TEXT_SIZE, 0.02, 0.15) };
  if (m.kind === "shape" && m.shape === "arrow") {
    // Both ends stay on the video; a very short arrow gets a little length.
    const x = clamp(m.x, 0, 1);
    const y = clamp(m.y, 0, 1);
    let w = clamp(x + m.w, 0, 1) - x;
    const h = clamp(y + m.h, 0, 1) - y;
    if (Math.hypot(w, h) < 0.03) w = x > 0.5 ? -0.05 : 0.05;
    return { ...m, ...times, x: r4(x), y: r4(y), w: r4(w), h: r4(h), ...shapeLook(m) };
  }
  const w = clamp(Math.abs(m.w), 0.02, 1);
  const h = clamp(Math.abs(m.h), 0.02, 1);
  return { ...m, ...times, w: r4(w), h: r4(h), x: r4(clamp(m.x, 0, 1 - w)), y: r4(clamp(m.y, 0, 1 - h)), ...(m.kind === "shape" ? shapeLook(m) : {}) };
}

const shapeLook = (m: Mark): Partial<Mark> => ({ shape: SHAPES.some((s) => s.id === m.shape) ? m.shape : "rect", color: isHex(m.color) ? m.color.toLowerCase() : SHAPE_COLORS[0], stroke: clamp(m.stroke ?? 0.008, 0.002, 0.03), fill: m.fill === true && m.shape !== "arrow" });

export function validMarks(v: unknown): Mark[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Mark => typeof m === "object" && m !== null && ["blur", "text", "image", "shape"].includes(m.kind) && typeof m.id === "string" && [m.a, m.b, m.x, m.y, m.w, m.h].every((n) => typeof n === "number" && Number.isFinite(n)))
    .filter((m) => m.kind !== "image" || (isImageRef(m.file) && m.file.startsWith("media:")))
    .map((m) => fitMark(m, Number.POSITIVE_INFINITY));
}

/**
 * A shape as an SVG picture of its own box in a W×H video: the box in pixels (with room for the
 * line) and the SVG to draw there.
 */
export function shapeSvg(m: Mark, W: number, H: number): { x: number; y: number; w: number; h: number; svg: string } {
  const sw = Math.max(2, (m.stroke ?? 0.008) * H);
  const pad = Math.ceil(sw * (m.shape === "arrow" ? 3 : 1));
  const x0 = m.x * W;
  const y0 = m.y * H;
  const x1 = (m.x + m.w) * W;
  const y1 = (m.y + m.h) * H;
  const bx = Math.floor(Math.min(x0, x1) - pad);
  const by = Math.floor(Math.max(0, Math.min(y0, y1) - pad));
  const left = Math.max(0, bx);
  const bw = even(Math.min(W, Math.ceil(Math.max(x0, x1) + pad)) - left);
  const bh = even(Math.min(H, Math.ceil(Math.max(y0, y1) + pad)) - by);
  const c = m.color ?? SHAPE_COLORS[0];
  const n = (v: number) => (Math.round(v * 10) / 10).toString();
  const lx = (v: number) => n(v - left);
  const ly = (v: number) => n(v - by);
  let body = "";
  const paint = m.fill ? `fill="${c}" stroke="none"` : `fill="none" stroke="${c}" stroke-width="${n(sw)}"`;
  if (m.shape === "ellipse") body = `<ellipse cx="${lx((x0 + x1) / 2)}" cy="${ly((y0 + y1) / 2)}" rx="${n(Math.max(1, Math.abs(x1 - x0) / 2 - (m.fill ? 0 : sw / 2)))}" ry="${n(Math.max(1, Math.abs(y1 - y0) / 2 - (m.fill ? 0 : sw / 2)))}" ${paint}/>`;
  else if (m.shape === "arrow") {
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const head = Math.min(len * 0.6, sw * 4.5);
    const bxp = x1 - ux * head;
    const byp = y1 - uy * head;
    const wing = head * 0.6;
    body = `<line x1="${lx(x0)}" y1="${ly(y0)}" x2="${lx(bxp + ux * sw * 0.5)}" y2="${ly(byp + uy * sw * 0.5)}" stroke="${c}" stroke-width="${n(sw)}" stroke-linecap="round"/><polygon points="${lx(x1)},${ly(y1)} ${lx(bxp - uy * wing)},${ly(byp + ux * wing)} ${lx(bxp + uy * wing)},${ly(byp - ux * wing)}" fill="${c}" stroke="${c}" stroke-width="${n(sw * 0.4)}" stroke-linejoin="round"/>`;
  } else {
    const inset = m.fill ? 0 : sw / 2;
    body = `<rect x="${lx(Math.min(x0, x1) + inset)}" y="${ly(Math.min(y0, y1) + inset)}" width="${n(Math.max(1, Math.abs(x1 - x0) - 2 * inset))}" height="${n(Math.max(1, Math.abs(y1 - y0) - 2 * inset))}" rx="${n(sw * 1.5)}" ${paint}/>`;
  }
  return { x: left, y: by, w: bw, h: bh, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}" viewBox="0 0 ${bw} ${bh}">${body}</svg>` };
}

/** A picture mark's box in a W×H video (even sizes). */
export function imageBox(m: Mark, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const w = Math.min(even(m.w * W), W);
  const h = Math.min(even(m.h * H), H);
  return { x: Math.min(Math.round(m.x * W), W - w), y: Math.min(Math.round(m.y * H), H - h), w, h };
}

/** Pictures drawn over the finished video (shapes rendered to PNG, and picture marks): `input` is
 *  each picture's input number. Returns the output label. */
export function overlayChains(chains: string[], items: ReadonlyArray<{ input: number; x: number; y: number; w: number; h: number; a: number; b: number }>, input: string): string {
  let last = input;
  items.forEach((o, i) => {
    chains.push(`[${o.input}:v]scale=${o.w}:${o.h}:flags=lanczos,format=rgba[ovi${i}]`);
    chains.push(`${last}[ovi${i}]overlay=x=${o.x}:y=${o.y}:format=auto:enable='between(t,${r4(o.a)},${r4(o.b)})'[ovl${i}]`);
    last = `[ovl${i}]`;
  });
  return last;
}

/** Escape a value for a filter option inside a filter graph (FFmpeg's two escaping levels). */
export function filterValue(s: string): string {
  const option = s.replace(/[\\':]/g, (c) => `\\${c}`);
  return option.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

/** Blur chains on `input` (the W×H recording picture); returns the output label. */
export function blurChains(chains: string[], marks: readonly Mark[], input: string, W: number, H: number): string {
  let last = input;
  marks
    .filter((m) => m.kind === "blur")
    .forEach((m, i) => {
      const w = Math.min(even(m.w * W), W);
      const h = Math.min(even(m.h * H), H);
      const x = Math.min(Math.round(m.x * W), W - w);
      const y = Math.min(Math.round(m.y * H), H - h);
      // The radius fits the colour planes, which are half as large.
      const r = Math.max(1, Math.min(24, Math.floor(Math.min(w, h) / 4) - 1));
      chains.push(`${last}split=2[bm${i}][bs${i}]`);
      chains.push(`[bs${i}]crop=${w}:${h}:${x}:${y},boxblur=lr=${r}:lp=3:cr=${Math.max(1, Math.floor(r / 2))}:cp=3[bb${i}]`);
      chains.push(`[bm${i}][bb${i}]overlay=x=${x}:y=${y}:enable='between(t,${r4(m.a)},${r4(m.b)})'[blur${i}]`);
      last = `[blur${i}]`;
    });
  return last;
}

/** Text labels on `input` (the W×H finished picture) with `font` (a font file); returns the label. */
export function textChains(chains: string[], marks: readonly Mark[], font: string, input: string, W: number, H: number): string {
  const texts = marks.filter((m) => m.kind === "text" && (m.text ?? "").trim());
  if (!texts.length) return input;
  const parts = texts.map((m) => {
    const size = Math.max(8, Math.round((m.size ?? TEXT_SIZE) * H));
    const pad = Math.round(size * 0.4);
    return `drawtext=fontfile=${filterValue(font)}:expansion=none:text=${filterValue(m.text!.trim())}:fontsize=${size}:fontcolor=white:box=1:boxcolor=0x0c0e13@0.78:boxborderw=${pad}:x=${Math.round(m.x * W) + pad}:y=${Math.round(m.y * H) + pad}:enable='between(t,${r4(m.a)},${r4(m.b)})'`;
  });
  chains.push(`${input}${parts.join(",")}[texted]`);
  return "[texted]";
}
