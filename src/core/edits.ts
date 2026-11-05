// Edits on a take, in the recording's own seconds: split points, removed stretches (cuts),
// per-zoom changes (depth, or off), zooms placed by hand, sped-up and slowed-down stretches,
// marks (blur, text, pictures, shapes), extra sound, the sound and smooth cursor settings, and
// the take's look (core/style.ts). Kept in take.json (`edit`), all undoable. Pure.
import { DEFAULT_CURSOR, validCursor, type CursorLook } from "./cursor";
import { isImageRef } from "./frame";
import { validMarks, type Mark } from "./marks";
import { DEFAULT_STYLE, validStyle, type EditorStyle } from "./style";
import { validManualZooms, type ManualZoom, type ZoomRegion } from "./zoom";

export interface Span {
  a: number;
  b: number;
}

/** A change to one click zoom: `at` is a moment inside it (zooms are recomputed from clicks, so
 *  they are found again by time). */
export interface ZoomEdit {
  at: number;
  zoom?: number;
  off?: boolean;
}

/** A stretch played faster (quiet parts) or slower (rate below 1), in recording seconds. */
export interface SpeedSpan extends Span {
  rate: number;
}

/** Extra sound (music, a voice-over) added to the take: the file ("media:<name>") starts at `a`
 *  (recording seconds) and plays `len` seconds of it, from `from` seconds into the file. */
export interface AudioClip {
  id: string;
  file: string;
  /** The name to show (the file the user picked). */
  name: string;
  a: number;
  len: number;
  from: number;
  volume: number;
}

/** Volumes (1 = as recorded, up to 2) and the microphone's noise cleanup. Without separate sound
 *  tracks, `system` is the recording's own sound. */
export interface SoundLook {
  system: number;
  mic: number;
  clean: boolean;
}
export const DEFAULT_SOUND: SoundLook = { system: 1, mic: 1, clean: false };

export interface TakeEdit {
  splits: number[];
  cuts: Span[];
  zooms: ZoomEdit[];
  speeds: SpeedSpan[];
  marks: Mark[];
  sound: SoundLook;
  cursor: CursorLook;
  /** Zooms placed by hand. */
  added: ManualZoom[];
  audio: AudioClip[];
  style: EditorStyle;
}

export const EMPTY_EDIT: TakeEdit = { splits: [], cuts: [], zooms: [], speeds: [], marks: [], sound: DEFAULT_SOUND, cursor: DEFAULT_CURSOR, added: [], audio: [], style: DEFAULT_STYLE };
/** Shorter pieces than this are not made by a split. */
export const MIN_PIECE = 0.1;

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Merge overlapping or touching spans, sorted, inside 0..duration. */
export function mergeSpans(spans: readonly Span[], duration: number): Span[] {
  const s = spans.map((x) => ({ a: Math.max(0, Math.min(x.a, x.b)), b: Math.min(duration, Math.max(x.a, x.b)) })).filter((x) => x.b - x.a > 1e-6).sort((x, y) => x.a - y.a);
  const out: Span[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.a <= last.b + 1e-6) last.b = Math.max(last.b, x.b);
    else out.push({ ...x });
  }
  return out;
}

/** The clip's pieces between split points. */
export function pieces(duration: number, splits: readonly number[]): Span[] {
  const at = [0, ...splits.filter((t) => t > 0 && t < duration).sort((x, y) => x - y), duration];
  const out: Span[] = [];
  for (let i = 0; i < at.length - 1; i++) if (at[i + 1]! - at[i]! > 1e-6) out.push({ a: at[i]!, b: at[i + 1]! });
  return out;
}

/** Add a split at `t` unless it would make a piece shorter than MIN_PIECE. */
export function addSplit(edit: TakeEdit, t: number, duration: number): TakeEdit {
  const near = [0, duration, ...edit.splits].some((s) => Math.abs(s - t) < MIN_PIECE);
  return near ? edit : { ...edit, splits: [...edit.splits, round(t)].sort((x, y) => x - y) };
}

export const isCut = (cuts: readonly Span[], t: number): boolean => cuts.some((c) => t >= c.a - 1e-6 && t < c.b - 1e-6);

/** Remove the piece, or bring it back when it is removed. */
export function togglePiece(edit: TakeEdit, piece: Span, duration: number): TakeEdit {
  const mid = (piece.a + piece.b) / 2;
  if (isCut(edit.cuts, mid)) {
    // Bring back: the cuts minus this piece.
    const cuts = edit.cuts.flatMap((c) => (c.b <= piece.a || c.a >= piece.b ? [c] : [{ a: c.a, b: piece.a }, { a: piece.b, b: c.b }]));
    return { ...edit, cuts: mergeSpans(cuts, duration) };
  }
  return { ...edit, cuts: mergeSpans([...edit.cuts, piece], duration) };
}

/** What is left after the cuts. */
export function keptSpans(duration: number, cuts: readonly Span[]): Span[] {
  const out: Span[] = [];
  let t = 0;
  for (const c of mergeSpans(cuts, duration)) {
    if (c.a > t) out.push({ a: t, b: c.a });
    t = c.b;
  }
  if (duration > t) out.push({ a: t, b: duration });
  return out;
}

export const keptDuration = (duration: number, cuts: readonly Span[]): number => keptSpans(duration, cuts).reduce((sum, s) => sum + s.b - s.a, 0);

/** Where playback continues from `t`: past a cut it lands on, or null at the end. */
export function playFrom(t: number, duration: number, cuts: readonly Span[]): number | null {
  const c = mergeSpans(cuts, duration).find((x) => t >= x.a - 1e-6 && t < x.b);
  if (!c) return t;
  return c.b >= duration - 1e-3 ? null : c.b;
}

/** FFmpeg expression true inside the cuts (for select/aselect: keep `not(...)`). */
export function cutExpr(cuts: readonly Span[], duration: number): string {
  return mergeSpans(cuts, duration)
    .map((c) => `between(t,${round(c.a)},${round(c.b)})`)
    .join("+");
}

/** Zooms with the edits applied: `off` ones are kept in the list (to show) but marked. */
export function editedZooms(regions: readonly ZoomRegion[], edits: readonly ZoomEdit[]): Array<ZoomRegion & { off: boolean; edited: boolean }> {
  return regions.map((r) => {
    const e = edits.find((x) => x.at >= r.start && x.at < r.end);
    return { ...r, zoom: e?.zoom ?? r.zoom, off: !!e?.off, edited: !!e };
  });
}

/** Change one zoom (found by a moment inside it); an empty change removes the edit. */
export function editZoom(edit: TakeEdit, region: { start: number; end: number }, change: Omit<ZoomEdit, "at"> | null): TakeEdit {
  const rest = edit.zooms.filter((x) => !(x.at >= region.start && x.at < region.end));
  if (!change || (change.zoom === undefined && !change.off)) return { ...edit, zooms: rest };
  return { ...edit, zooms: [...rest, { at: round((region.start + region.end) / 2), ...change }] };
}

export function validAudio(v: unknown): AudioClip[] {
  if (!Array.isArray(v)) return [];
  const n = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return v
    .filter((c): c is AudioClip => typeof c === "object" && c !== null && typeof c.id === "string" && isImageRef(c.file) && c.file.startsWith("media:"))
    .map((c) => ({ id: c.id, file: c.file, name: typeof c.name === "string" ? c.name.slice(0, 120) : "Sound", a: round(n(c.a, 0, 1e6, 0)), len: round(n(c.len, 0.1, 1e6, 1)), from: round(n(c.from, 0, 1e6, 0)), volume: n(c.volume, 0, 2, 1) }));
}

/** A stored edit, repaired; `style` fills in the look for a take never edited (the recorder's choices). */
export function validEdit(v: unknown, style: EditorStyle = DEFAULT_STYLE): TakeEdit {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const nums = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0) : []);
  const spans = Array.isArray(o.cuts) ? o.cuts.filter((c): c is Span => typeof c === "object" && c !== null && typeof (c as Span).a === "number" && typeof (c as Span).b === "number") : [];
  const zooms = Array.isArray(o.zooms)
    ? o.zooms
        .filter((z): z is ZoomEdit => typeof z === "object" && z !== null && typeof (z as ZoomEdit).at === "number")
        .map((z) => ({ at: z.at, ...(typeof z.zoom === "number" ? { zoom: Math.min(3, Math.max(1.1, z.zoom)) } : {}), ...(z.off ? { off: true } : {}) }))
    : [];
  const sound = (typeof o.sound === "object" && o.sound !== null ? o.sound : {}) as Record<string, unknown>;
  const vol = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 1);
  return {
    splits: nums(o.splits),
    cuts: spans.map((c) => ({ a: c.a, b: c.b })),
    zooms,
    speeds: validSpeeds(o.speeds),
    marks: validMarks(o.marks),
    sound: { system: vol(sound.system), mic: vol(sound.mic), clean: sound.clean === true },
    cursor: validCursor(o.cursor),
    added: validManualZooms(o.added),
    audio: validAudio(o.audio),
    style: validStyle(o.style, style),
  };
}

export function validSpeeds(v: unknown): SpeedSpan[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is SpeedSpan => typeof s === "object" && s !== null && [s.a, s.b, s.rate].every((n) => typeof n === "number" && Number.isFinite(n)))
    .filter((s) => s.b > s.a && s.a >= 0 && s.rate >= 0.25 && s.rate <= 16 && Math.abs(s.rate - 1) > 1e-6)
    .map((s) => ({ a: round(s.a), b: round(s.b), rate: s.rate }));
}

/** Speed stretches up, or slow them down (replacing speed changes they overlap). */
export function addSpeeds(edit: TakeEdit, spans: readonly Span[], rate: number): TakeEdit {
  const rest = edit.speeds.filter((s) => !spans.some((x) => x.a < s.b && x.b > s.a));
  return { ...edit, speeds: [...rest, ...spans.map((x) => ({ a: round(x.a), b: round(x.b), rate }))].sort((p, q) => p.a - q.a) };
}

/** Back to normal speed where the stretches are. */
export const removeSpeeds = (edit: TakeEdit, spans: readonly Span[]): TakeEdit => ({ ...edit, speeds: edit.speeds.filter((s) => !spans.some((x) => x.a < s.b && x.b > s.a)) });
