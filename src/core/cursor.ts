// The smooth cursor: drawn from the pointer path instead of the recorded one, so it glides and
// can be larger. The track is sampled at a fixed rate and smoothed without lag (forward and back),
// used by the preview (poseAt) and the export (FFmpeg sendcmd moving an overlay). Effects: a
// bounce on each click, a sway (tilt) with sideways movement, motion blur, and a loop mode that
// brings the cursor back to where it started for videos that repeat. Pure.

/** Pointer positions in recording seconds and 0..1 of the picture (TakeData.path). */
export type PathPoint = { t: number; x: number; y: number };

export interface CursorLook {
  /** Draw the cursor (only for takes recorded with "Smooth cursor"). */
  on: boolean;
  /** Size relative to a normal cursor (1 = about 2.8% of the picture's height). */
  size: number;
  /** 0 = follows the mouse exactly, 1 = very soft. */
  smooth: number;
  /** Motion blur, click bounce and sway strength, 0 (off) .. 1. */
  blur: number;
  bounce: number;
  sway: number;
  /** Return to the starting point at the end (for looping videos and GIFs). */
  loop: boolean;
}

export const DEFAULT_CURSOR: CursorLook = { on: true, size: 1.6, smooth: 0.5, blur: 0, bounce: 0.5, sway: 0, loop: false };

/** A cursor look read back from take.json (older takes have only on, size and smoothing). */
export function validCursor(v: unknown): CursorLook {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const n = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
  return {
    on: o.on !== false,
    size: n(o.size, 0.6, 3, DEFAULT_CURSOR.size),
    smooth: n(o.smooth, 0, 1, DEFAULT_CURSOR.smooth),
    blur: n(o.blur, 0, 1, DEFAULT_CURSOR.blur),
    bounce: n(o.bounce, 0, 1, DEFAULT_CURSOR.bounce),
    sway: n(o.sway, 0, 1, DEFAULT_CURSOR.sway),
    loop: o.loop === true,
  };
}

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

/** Seconds over which a looping cursor glides back to its start. */
export const LOOP_TIME = 0.8;

/** Positions every 1/TRACK_RATE s from 0 to `duration`, smoothed (zero lag); empty without a path.
 *  With `loop` the last moments glide back to the first position. */
export function cursorTrack(path: readonly PathPoint[], duration: number, smooth: number, loop = false): Array<{ x: number; y: number }> {
  if (!path.length || duration <= 0) return [];
  const n = Math.floor(duration * TRACK_RATE) + 1;
  const out = Array.from({ length: n }, (_, i) => ({ ...rawAt(path, i / TRACK_RATE) }));
  const tau = Math.max(0, Math.min(1, smooth)) * 0.12;
  if (tau > 0) {
    const a = Math.exp(-1 / TRACK_RATE / tau);
    for (let i = 1; i < n; i++) (out[i]!.x = a * out[i - 1]!.x + (1 - a) * out[i]!.x), (out[i]!.y = a * out[i - 1]!.y + (1 - a) * out[i]!.y);
    for (let i = n - 2; i >= 0; i--) (out[i]!.x = a * out[i + 1]!.x + (1 - a) * out[i]!.x), (out[i]!.y = a * out[i + 1]!.y + (1 - a) * out[i]!.y);
  }
  if (loop && n > 2) {
    const first = { ...out[0]! };
    const from = Math.max(1, n - 1 - Math.round(Math.min(LOOP_TIME, duration / 2) * TRACK_RATE));
    for (let i = from; i < n; i++) {
      const k = ease01((i - from) / (n - 1 - from));
      out[i] = { x: out[i]!.x + (first.x - out[i]!.x) * k, y: out[i]!.y + (first.y - out[i]!.y) * k };
    }
  }
  return out;
}

const ease01 = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** Where the cursor is and how it looks at one moment: scale (bounce) and tilt in radians (sway). */
export interface Pose {
  x: number;
  y: number;
  s: number;
  a: number;
}

/** Seconds a click bounce lasts, how far it shrinks at most, and the largest tilt. */
const BOUNCE_TIME = 0.28;
const BOUNCE_DEPTH = 0.3;
const MAX_TILT = 0.4;

/** The track with the bounce (`clicks` in recording seconds) and sway applied. */
export function cursorPoses(track: ReadonlyArray<{ x: number; y: number }>, look: Pick<CursorLook, "bounce" | "sway">, clicks: readonly number[]): Pose[] {
  const sorted = [...clicks].sort((p, q) => p - q);
  let ci = 0;
  let tilt = 0;
  // The tilt follows sideways speed, eased so it leans in and settles back gently.
  const follow = Math.exp(-1 / TRACK_RATE / 0.09);
  return track.map((p, i) => {
    const t = i / TRACK_RATE;
    while (ci < sorted.length && sorted[ci]! + BOUNCE_TIME < t) ci++;
    let s = 1;
    for (let k = ci; k < sorted.length && sorted[k]! <= t; k++) {
      const d = (t - sorted[k]!) / BOUNCE_TIME;
      if (d >= 0 && d <= 1) s = Math.min(s, 1 - look.bounce * BOUNCE_DEPTH * Math.sin(Math.PI * d));
    }
    const prev = track[Math.max(0, i - 1)]!;
    const vx = (p.x - prev.x) * TRACK_RATE;
    const want = look.sway > 0 ? Math.max(-MAX_TILT, Math.min(MAX_TILT, vx * 0.9)) * look.sway : 0;
    tilt = follow * tilt + (1 - follow) * want;
    return { x: p.x, y: p.y, s, a: Math.abs(tilt) < 1e-4 ? 0 : tilt };
  });
}

export function poseAt(poses: readonly Pose[], t: number): Pose | null {
  if (!poses.length) return null;
  const f = Math.max(0, Math.min(poses.length - 1, t * TRACK_RATE));
  const i = Math.floor(f);
  const a = poses[i]!;
  const b = poses[Math.min(poses.length - 1, i + 1)]!;
  const k = f - i;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, s: a.s + (b.s - a.s) * k, a: a.a + (b.a - a.a) * k };
}

/** Motion blur in the preview: a blur in pixels for the speed at `t`, on a picture `height` px tall. */
export function blurAt(poses: readonly Pose[], t: number, strength: number, height: number): number {
  if (strength <= 0 || poses.length < 2) return 0;
  const i = Math.max(1, Math.min(poses.length - 1, Math.round(t * TRACK_RATE)));
  const v = Math.hypot(poses[i]!.x - poses[i - 1]!.x, poses[i]!.y - poses[i - 1]!.y) * TRACK_RATE;
  return Math.min(6, v * strength * height * 0.004);
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
 * FFmpeg chains drawing the cursor on `input` (a W×H picture at `fps`) from input `image` (the
 * cursor PNG). The overlay `overlay@cur` is moved by sendcmd; with a bounce or sway the image also
 * runs as a stream that `scale@cur` and `rotate@cur` change per sample; with motion blur the
 * cursor is drawn on a clear layer that blends a few frames before it goes on the picture.
 * Returns the output label.
 */
export function cursorChains(chains: string[], poses: readonly Pose[], look: CursorLook, image: number, input: string, W: number, H: number, fps = 30): string {
  if (!look.on || !poses.length) return input;
  const s = cursorScale(H, look.size);
  const iw = Math.max(2, Math.round(CURSOR_IMAGE.w * s));
  const ih = Math.max(2, Math.round(CURSOR_IMAGE.h * s));
  const moving = poses.some((p) => p.s < 0.999 || p.a !== 0);
  // A turned cursor sits in a square big enough for any angle.
  const D = moving ? 2 * Math.ceil(Math.hypot(iw, ih) / 2) + 2 : 0;
  const place = (p: Pose) => {
    const w = moving ? Math.max(2, 2 * Math.round((iw * p.s) / 2)) : iw;
    const h = moving ? Math.max(2, 2 * Math.round((ih * p.s) / 2)) : ih;
    let tx = (CURSOR_IMAGE.tipX * s * w) / iw;
    let ty = (CURSOR_IMAGE.tipY * s * h) / ih;
    if (moving) {
      // The tip turns about the image's centre (rotate turns clockwise for a positive angle).
      const vx = tx - w / 2;
      const vy = ty - h / 2;
      tx = D / 2 + vx * Math.cos(p.a) - vy * Math.sin(p.a);
      ty = D / 2 + vx * Math.sin(p.a) + vy * Math.cos(p.a);
    }
    return { x: Math.round(p.x * W - tx), y: Math.round(p.y * H - ty), w, h, a: p.a };
  };
  // One command per sample where something changed.
  const cmds: string[] = [];
  let last = "";
  poses.forEach((p, i) => {
    const q = place(p);
    const key = `${q.x},${q.y},${q.w},${q.a.toFixed(3)}`;
    if (key === last) return;
    last = key;
    const parts = [`overlay@cur x ${q.x}`, `overlay@cur y ${q.y}`];
    if (moving) parts.push(`scale@cur w ${q.w}`, `scale@cur h ${q.h}`, `rotate@cur a ${q.a.toFixed(4)}`);
    cmds.push(`${(i / TRACK_RATE).toFixed(3)} ${parts.join(", ")}`);
  });
  const first = place(poses[0]!);
  chains.push(
    moving
      ? `[${image}:v]scale=${iw}:${ih}:flags=lanczos,format=rgba,loop=loop=-1:size=1,setpts=N/${fps}/TB,scale@cur=w=${first.w}:h=${first.h}:flags=bilinear,rotate@cur=a=${first.a.toFixed(4)}:ow=${D}:oh=${D}:c=none[curimg]`
      : `[${image}:v]scale=${iw}:${ih}:flags=lanczos,format=rgba[curimg]`,
  );
  const send = `sendcmd=c='${cmds.join(";")}'`;
  if (look.blur > 0.01) {
    // Drawn on a clear layer that mixes the last few frames: a short trail behind a fast cursor.
    const frames = 2 + Math.round(look.blur * 3);
    chains.push(`color=c=black@0:s=${W}x${H}:r=${fps},format=rgba,${send}[curbase]`);
    chains.push(`[curbase][curimg]overlay@cur=x=${first.x}:y=${first.y}:eval=frame:format=auto,tmix=frames=${frames}[curlayer]`);
    chains.push(`${input}[curlayer]overlay=format=auto:shortest=1[withcur]`);
    return "[withcur]";
  }
  chains.push(`${input}${send}[curcmd]`);
  chains.push(`[curcmd][curimg]overlay@cur=x=${first.x}:y=${first.y}:eval=frame:format=auto${moving ? ":shortest=1" : ""}[withcur]`);
  return "[withcur]";
}
