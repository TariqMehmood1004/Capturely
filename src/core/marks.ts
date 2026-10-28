// Blur and text added in the editor. A blur covers part of the recording (it zooms with it); a
// text label sits on the finished video (it stays put). Both show between two moments of the
// recording. Positions and sizes are 0..1 of their picture. Pure.

export interface Mark {
  id: string;
  kind: "blur" | "text";
  /** Shown from `a` to `b` (recording seconds). */
  a: number;
  b: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Text labels: the words and the letter height as a share of the video's height. */
  text?: string;
  size?: number;
}

export const TEXT_SIZE = 0.045;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** A new mark at `t`, in the middle, shown for `len` seconds (to the end at most). */
export function newMark(kind: Mark["kind"], t: number, duration: number, len = 3): Mark {
  const a = clamp(t, 0, Math.max(0, duration - 0.5));
  return {
    id: `${kind}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
    kind,
    a: r4(a),
    b: r4(Math.min(duration, a + len)),
    ...(kind === "blur" ? { x: 0.35, y: 0.35, w: 0.3, h: 0.12 } : { x: 0.06, y: 0.84, w: 0, h: 0, text: "Your text", size: TEXT_SIZE }),
  };
}

/** Keep a mark on its picture and its times in order. */
export function fitMark(m: Mark, duration: number): Mark {
  const a = clamp(Math.min(m.a, m.b), 0, duration);
  const b = clamp(Math.max(m.a, m.b), a + 0.1, Math.max(a + 0.1, duration));
  const w = m.kind === "blur" ? clamp(m.w, 0.02, 1) : 0;
  const h = m.kind === "blur" ? clamp(m.h, 0.02, 1) : 0;
  return { ...m, a: r4(a), b: r4(b), w: r4(w), h: r4(h), x: r4(clamp(m.x, 0, 1 - w)), y: r4(clamp(m.y, 0, 1 - h)), ...(m.kind === "text" ? { text: (m.text ?? "").replace(/\s*\n\s*/g, " ").slice(0, 120), size: clamp(m.size ?? TEXT_SIZE, 0.02, 0.15) } : {}) };
}

export function validMarks(v: unknown): Mark[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is Mark => typeof m === "object" && m !== null && (m.kind === "blur" || m.kind === "text") && typeof m.id === "string" && [m.a, m.b, m.x, m.y, m.w, m.h].every((n) => typeof n === "number" && Number.isFinite(n)))
    .map((m) => fitMark(m, Number.POSITIVE_INFINITY));
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
