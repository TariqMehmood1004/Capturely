// The smooth cursor: drawn from the pointer path instead of the recorded one, so it glides and
// can be larger. The track is sampled at a fixed rate and smoothed without lag (forward and back),
// used by the preview (cursorAt) and the export (FFmpeg sendcmd moving an overlay). Pure.

/** Pointer positions in recording seconds and 0..1 of the picture (TakeData.path). */
export type PathPoint = { t: number; x: number; y: number };

export interface CursorLook {
  /** Draw the cursor (only for takes recorded with "Smooth cursor"). */
  on: boolean;
  /** Size relative to a normal cursor (1 = about 2.8% of the picture's height). */
  size: number;
  /** 0 = follows the mouse exactly, 1 = very soft. */
  smooth: number;
}

export const DEFAULT_CURSOR: CursorLook = { on: true, size: 1.6, smooth: 0.5 };

/** src/assets/cursor.png (scripts/make-cursor.py): image size, the arrow tip, the arrow's height. */
export const CURSOR_IMAGE = { w: 114, h: 162, tipX: 18, tipY: 18, arrowH: 126 } as const;
/** Arrow height as a share of the picture's height at size 1. */
const BASE = 0.028;

/** Samples per second of the track. */
export const TRACK_RATE = 30;

/** The path is logged only while the mouse moves: it holds still between points that are far
 *  apart in time, and moves only in the last moment before the next one. */
const HOLD_GAP = 0.06;

function rawAt(path: readonly PathPoint[], t: number): { x: number; y: number } {
  if (t <= path[0]!.t) return path[0]!;
  const last = path[path.length - 1]!;
  if (t >= last.t) return last;
  let lo = 0;
  let hi = path.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = path[lo]!;
  const b = path[hi]!;
  const start = Math.max(a.t, b.t - HOLD_GAP);
  if (t <= start) return a;
  const k = (t - start) / (b.t - start);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** Positions every 1/TRACK_RATE s from 0 to `duration`, smoothed (zero lag); empty without a path. */
export function cursorTrack(path: readonly PathPoint[], duration: number, smooth: number): Array<{ x: number; y: number }> {
  if (!path.length || duration <= 0) return [];
  const n = Math.floor(duration * TRACK_RATE) + 1;
  const out = Array.from({ length: n }, (_, i) => ({ ...rawAt(path, i / TRACK_RATE) }));
  const tau = Math.max(0, Math.min(1, smooth)) * 0.12;
  if (tau > 0) {
    const a = Math.exp(-1 / TRACK_RATE / tau);
    for (let i = 1; i < n; i++) (out[i]!.x = a * out[i - 1]!.x + (1 - a) * out[i]!.x), (out[i]!.y = a * out[i - 1]!.y + (1 - a) * out[i]!.y);
    for (let i = n - 2; i >= 0; i--) (out[i]!.x = a * out[i + 1]!.x + (1 - a) * out[i]!.x), (out[i]!.y = a * out[i + 1]!.y + (1 - a) * out[i]!.y);
  }
  return out;
}

export function cursorAt(track: ReadonlyArray<{ x: number; y: number }>, t: number): { x: number; y: number } | null {
  if (!track.length) return null;
  const f = Math.max(0, Math.min(track.length - 1, t * TRACK_RATE));
  const i = Math.floor(f);
  const a = track[i]!;
  const b = track[Math.min(track.length - 1, i + 1)]!;
  const k = f - i;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

/** The cursor image's height as a share of the picture's height (for the preview). */
export const cursorImageShare = (size: number): number => (BASE * size * CURSOR_IMAGE.h) / CURSOR_IMAGE.arrowH;

/** The cursor image's scale for a picture `height` pixels tall. */
export const cursorScale = (height: number, size: number): number => (height * BASE * size) / CURSOR_IMAGE.arrowH;

/**
 * FFmpeg chains drawing the cursor on `input` (a W×H picture) from input `image` (the cursor
 * PNG): the image is scaled once, an overlay named `overlay@cur` is moved by sendcmd. Returns
 * the output label.
 */
export function cursorChains(chains: string[], track: ReadonlyArray<{ x: number; y: number }>, look: CursorLook, image: number, input: string, W: number, H: number): string {
  if (!look.on || !track.length) return input;
  const s = cursorScale(H, look.size);
  const iw = Math.max(2, Math.round(CURSOR_IMAGE.w * s));
  const ih = Math.max(2, Math.round(CURSOR_IMAGE.h * s));
  const tipX = CURSOR_IMAGE.tipX * s;
  const tipY = CURSOR_IMAGE.tipY * s;
  const pos = (p: { x: number; y: number }) => [Math.round(p.x * W - tipX), Math.round(p.y * H - tipY)] as const;
  // One command per sample where the position changed.
  const cmds: string[] = [];
  let last = "";
  track.forEach((p, i) => {
    const [x, y] = pos(p);
    const key = `${x},${y}`;
    if (key === last) return;
    last = key;
    cmds.push(`${(i / TRACK_RATE).toFixed(3)} overlay@cur x ${x}, overlay@cur y ${y}`);
  });
  const [x0, y0] = pos(track[0]!);
  chains.push(`[${image}:v]scale=${iw}:${ih}:flags=lanczos,format=rgba[curimg]`);
  chains.push(`${input}sendcmd=c='${cmds.join(";")}'[curcmd]`);
  chains.push(`[curcmd][curimg]overlay@cur=x=${x0}:y=${y0}:eval=frame:format=auto[withcur]`);
  return "[withcur]";
}
