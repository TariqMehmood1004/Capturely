// Quiet parts: stretches where the picture does not change, no one speaks and the mouse rests.
// FFmpeg finds still picture (freezedetect) and silence (silencedetect); this keeps their overlap,
// minus moments the pointer moved (the smooth cursor is drawn later, so the picture looks still
// while it moves). Pure.
import type { Span } from "./edits";

/** Overlap of two sorted span lists. */
function overlap(x: readonly Span[], y: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const a = Math.max(x[i]!.a, y[j]!.a);
    const b = Math.min(x[i]!.b, y[j]!.b);
    if (b > a) out.push({ a, b });
    if (x[i]!.b < y[j]!.b) i++;
    else j++;
  }
  return out;
}

const sorted = (s: readonly Span[]) => [...s].filter((x) => x.b > x.a).sort((p, q) => p.a - q.a);

/**
 * Quiet spans at least `min` seconds long. `silences` null means the recording has no sound (then
 * the picture alone decides). Pointer moves (seconds) break a span `pad` seconds around them.
 * Each span is shrunk by `edge` at both ends, so speech or motion just before or after is kept.
 */
export function quietSpans(freezes: readonly Span[], silences: readonly Span[] | null, moves: readonly number[], min = 2, pad = 0.4, edge = 0.25): Span[] {
  let spans = silences ? overlap(sorted(freezes), sorted(silences)) : sorted(freezes);
  const busy = [...moves].sort((p, q) => p - q);
  spans = spans.flatMap((s) => {
    const parts: Span[] = [];
    let a = s.a;
    for (const m of busy) {
      if (m + pad <= a) continue;
      if (m - pad >= s.b) break;
      if (m - pad > a) parts.push({ a, b: m - pad });
      a = Math.max(a, m + pad);
    }
    if (s.b > a) parts.push({ a, b: s.b });
    return parts;
  });
  return spans.map((s) => ({ a: s.a + edge, b: s.b - edge })).filter((s) => s.b - s.a >= min);
}
