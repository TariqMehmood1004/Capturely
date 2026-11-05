// The finished video's clock: the recording with cuts left out and some stretches sped up (quiet
// parts) or slowed down. Every effect runs on the recording's own seconds; this maps them to the output at the
// very end of the export, and tells the preview how fast to play. Pure.
import { mergeSpans, type Span, type SpeedSpan } from "./edits";

/** A piece of the recording and how it plays: rate 0 = left out. */
export interface Segment extends Span {
  rate: number;
}

/** Speed-ups offered (quiet parts), and every rate a speed region can have. */
export const SPEEDS = [2, 4, 8] as const;
export const RATES = [0.25, 0.5, 2, 4, 8] as const;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The recording cut into segments, in order, covering 0..duration. Cuts win over speeds. */
export function segments(duration: number, cuts: readonly Span[], speeds: readonly SpeedSpan[] = []): Segment[] {
  const marks = new Set([0, duration]);
  const cutList = mergeSpans(cuts, duration);
  const speedList = speeds.filter((s) => s.rate > 0 && Math.abs(s.rate - 1) > 1e-6 && s.b > s.a).map((s) => ({ a: Math.max(0, s.a), b: Math.min(duration, s.b), rate: s.rate }));
  for (const s of [...cutList, ...speedList]) marks.add(s.a).add(s.b);
  const at = [...marks].filter((t) => t >= 0 && t <= duration).sort((x, y) => x - y);
  const out: Segment[] = [];
  for (let i = 0; i < at.length - 1; i++) {
    const a = at[i]!;
    const b = at[i + 1]!;
    if (b - a < 1e-6) continue;
    const mid = (a + b) / 2;
    const rate = cutList.some((c) => mid >= c.a && mid < c.b) ? 0 : (speedList.find((s) => mid >= s.a && mid < s.b)?.rate ?? 1);
    const prev = out[out.length - 1];
    if (prev && prev.rate === rate && Math.abs(prev.b - a) < 1e-6) prev.b = b;
    else out.push({ a, b, rate });
  }
  return out;
}

/** The output's length. */
export const outDuration = (segs: readonly Segment[]): number => segs.reduce((sum, s) => sum + (s.rate ? (s.b - s.a) / s.rate : 0), 0);

/** How fast the preview plays at `t` (0 inside a cut). */
export const rateAt = (segs: readonly Segment[], t: number): number => segs.find((s) => t >= s.a && t < s.b)?.rate ?? 1;

/** Output seconds for recording second `t` (inside a cut: where the output continues). */
export function outTime(segs: readonly Segment[], t: number): number {
  let o = 0;
  for (const s of segs) {
    if (t < s.b) return o + (s.rate ? (Math.max(t, s.a) - s.a) / s.rate : 0);
    o += s.rate ? (s.b - s.a) / s.rate : 0;
  }
  return o;
}

/** Played segments with their output start. */
function played(segs: readonly Segment[]): Array<Segment & { o: number }> {
  let o = 0;
  return segs.flatMap((s) => {
    if (!s.rate) return [];
    const r = { ...s, o };
    o += (s.b - s.a) / s.rate;
    return [r];
  });
}

/** Choose among sorted pieces by time as a balanced tree of if(lt(T,...)) (shallow for FFmpeg). */
function pick<T>(list: readonly T[], start: (x: T) => number, leaf: (x: T) => string, v = "T"): string {
  if (list.length === 1) return leaf(list[0]!);
  const mid = list.length >> 1;
  return `if(lt(${v},${r3(start(list[mid]!))}),${pick(list.slice(0, mid), start, leaf, v)},${pick(list.slice(mid), start, leaf, v)})`;
}

/** Nothing to change: no cuts and no speed-ups. */
export const isPlain = (segs: readonly Segment[]): boolean => segs.every((s) => s.rate === 1);

/** FFmpeg chains putting `input` (on the recording's clock) on the output clock at `fps`. Frames
 *  past the recording's end (generated backgrounds never end) go on past the output's end, so
 *  the export's -t can stop it; dropping them would leave FFmpeg waiting forever. */
export function videoTimeChain(segs: readonly Segment[], fps: number, input: string, out: string): string {
  const end = segs[segs.length - 1]?.b ?? 0;
  const keep = [...played(segs), { a: end, b: Number.POSITIVE_INFINITY, rate: 1, o: outDuration(segs) }];
  const range = (s: Segment) => (Number.isFinite(s.b) ? `between(t,${r3(s.a)},${r3(s.b)})` : `gte(t,${r3(s.a)})`);
  const select = segs.some((s) => !s.rate) ? `select='${keep.map(range).join("+")}',` : "";
  const pts = pick(keep, (s) => s.a, (s) => (s.rate === 1 ? `${r3(s.o - s.a)}+T` : `${r3(s.o)}+(T-${r3(s.a)})/${s.rate}`));
  return `${input}${select}setpts='(${pts})/TB',fps=${fps}${out}`;
}

/** `atempo` steps for a rate (each step must stay within 0.5 .. 2). */
function tempo(rate: number): string[] {
  const out: string[] = [];
  let r = rate;
  while (r < 0.5 - 1e-9) (out.push("atempo=0.5"), (r /= 0.5));
  while (r > 2 + 1e-9) (out.push("atempo=2"), (r /= 2));
  if (Math.abs(r - 1) > 1e-6) out.push(`atempo=${r3(r)}`);
  return out;
}

/** The sound on the output clock: kept pieces at normal speed; a sped-up piece keeps only its
 *  start (as long as the piece now lasts), a slowed-down piece is stretched (pitch kept), so
 *  sound and picture stay together. */
export function audioTimeChain(segs: readonly Segment[], input: string, out: string): string {
  const list = played(segs);
  if (list.every((s) => s.rate >= 1)) {
    const keep = list.map((s) => `between(t,${r3(s.a)},${r3(s.a + (s.b - s.a) / s.rate)})`);
    return `${input}aselect='${keep.join("+")}',asetpts=N/SR/TB${out}`;
  }
  // Slowed pieces need their own tempo: each piece is trimmed, changed and joined again.
  const labels = list.map((_, i) => `[ats${i}]`);
  const parts = list.map((s, i) => {
    const end = s.rate > 1 ? s.a + (s.b - s.a) / s.rate : s.b;
    return `${labels[i]}atrim=start=${r3(s.a)}:end=${r3(end)},asetpts=PTS-STARTPTS${s.rate < 1 ? `,${tempo(s.rate).join(",")}` : ""}[atp${i}]`;
  });
  const split = list.length > 1 ? `${input}asplit=${list.length}${labels.join("")}` : `${input}anull${labels[0]}`;
  const join = list.length > 1 ? `${list.map((_, i) => `[atp${i}]`).join("")}concat=n=${list.length}:v=0:a=1${out}` : `[atp0]anull${out}`;
  return [split, ...parts, join].join(";\n");
}
