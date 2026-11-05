// Smooth click zooms (Screen Studio / Recordly style). A click zooms in on it; clicks that follow
// soon keep the zoom and glide there; with "follow" the view also glides after the pointer while it
// works nearby; when the pointer goes well outside the zoomed view the zoom eases back out. The
// preview evaluates the same keys the export turns into FFmpeg expressions. Pure.

export interface Point {
  t: number;
  x: number;
  y: number;
}

export interface ZoomRegion {
  start: number;
  end: number;
  zoom: number;
  /** Anchor while zooming in (0..1 of the picture). */
  fx: number;
  fy: number;
  /** Later anchors: the view glides to each at its time. */
  pans?: Array<{ t: number; fx: number; fy: number }>;
}

export type AfterClick = "follow" | "zoomOut";

export interface ZoomKey {
  t: number;
  /** Zoom depth (1 = the whole picture). */
  z: number;
  fx: number;
  fy: number;
}

/** Seconds to zoom in or out, to glide to a new point, and between two follow glides. */
export const ZOOM_RAMP = 0.6;
export const PAN_TIME = 0.55;
const FOLLOW_EVERY = 0.6;
export const MIN_REGION = 0.6;

/** Clicks into zoom blocks; clicks within `gap` seconds of the previous one glide instead. */
export function clickRegions(clicks: readonly Point[], duration: number, opts: { zoom: number; hold: number; gap?: number }): ZoomRegion[] {
  const gap = opts.gap ?? 2.5;
  const out: ZoomRegion[] = [];
  let last = -Infinity;
  for (const c of [...clicks].sort((a, b) => a.t - b.t)) {
    const cur = out[out.length - 1];
    if (cur && c.t - last <= gap) {
      (cur.pans ??= []).push({ t: c.t, fx: c.x, fy: c.y });
      cur.end = Math.min(duration, c.t + opts.hold + ZOOM_RAMP);
    } else {
      const start = Math.max(0, c.t - ZOOM_RAMP);
      if (cur && start < cur.end) cur.end = start;
      out.push({ start, end: Math.min(duration, c.t + opts.hold + ZOOM_RAMP), zoom: opts.zoom, fx: c.x, fy: c.y });
    }
    last = c.t;
  }
  return out.filter((r) => r.end - r.start >= MIN_REGION);
}

/** Click zooms that react to the pointer path (see the file comment). */
export function pointerZooms(clicks: readonly Point[], path: readonly Point[], duration: number, opts: { zoom: number; hold: number; after: AfterClick; gap?: number }): ZoomRegion[] {
  const out: ZoomRegion[] = [];
  let queue = clickRegions(clicks, duration, opts);
  while (queue.length) {
    const r = queue.shift()!;
    const half = 0.5 / r.zoom;
    const inner = [...(r.pans ?? [])];
    const pans: NonNullable<ZoomRegion["pans"]> = [];
    let f = { x: r.fx, y: r.fy };
    let end = r.end;
    let lastPan = r.start;
    let ci = 0;
    for (const p of path) {
      if (p.t <= r.start + ZOOM_RAMP) continue;
      if (p.t >= end - ZOOM_RAMP) break;
      while (ci < inner.length && inner[ci]!.t <= p.t) {
        const c = inner[ci++]!;
        pans.push(c);
        f = { x: c.fx, y: c.fy };
        lastPan = c.t;
      }
      const dx = Math.abs(p.x - f.x);
      const dy = Math.abs(p.y - f.y);
      if ((dx > half || dy > half) && (opts.after === "zoomOut" || dx > half * 1.6 || dy > half * 1.6)) {
        end = Math.max(r.start + 2 * ZOOM_RAMP + 0.1, p.t + ZOOM_RAMP);
        break;
      }
      if (opts.after === "follow" && (dx > half * 0.45 || dy > half * 0.45) && p.t - lastPan >= FOLLOW_EVERY) {
        pans.push({ t: p.t, fx: p.x, fy: p.y });
        f = { x: p.x, y: p.y };
        lastPan = p.t;
        end = Math.min(duration, Math.max(end, p.t + opts.hold + ZOOM_RAMP));
      }
    }
    const left = inner.filter((c) => c.t >= end - ZOOM_RAMP);
    const all = [...pans, ...inner.filter((c) => c.t < end - ZOOM_RAMP && !pans.includes(c))].sort((a, b) => a.t - b.t);
    const done: ZoomRegion = { start: r.start, end, zoom: r.zoom, fx: r.fx, fy: r.fy, ...(all.length ? { pans: all } : {}) };
    out.push(done);
    if (left.length) {
      const again = clickRegions(left.map((c) => ({ t: c.t, x: c.fx, y: c.fy })), duration, opts);
      if (again[0] && again[0].start < end) done.end = Math.max(r.start + MIN_REGION, again[0].start);
      queue = [...again, ...queue].sort((a, b) => a.start - b.start);
    }
  }
  return out;
}

/** A zoom placed by hand: from `a` to `b` (recording seconds), at depth `zoom`, on (x, y). */
export interface ManualZoom {
  id: string;
  a: number;
  b: number;
  zoom: number;
  x: number;
  y: number;
}

export const manualRegion = (m: ManualZoom): ZoomRegion => ({ start: m.a, end: m.b, zoom: m.zoom, fx: m.x, fy: m.y });

/** Click zooms that do not overlap a zoom placed by hand (those win), and the manual ones. */
export function withManual(regions: readonly ZoomRegion[], manual: readonly ManualZoom[]): ZoomRegion[] {
  const own = manual.map(manualRegion);
  return [...regions.filter((r) => !own.some((m) => m.start < r.end && m.end > r.start)), ...own].sort((a, b) => a.start - b.start);
}

/** A new zoom at `t` for `len` seconds (inside the recording). */
export function newManualZoom(t: number, duration: number, at: { x: number; y: number } = { x: 0.5, y: 0.5 }, zoom = 1.8, len = 3): ManualZoom {
  const a = Math.max(0, Math.min(t, duration - MIN_REGION));
  return fitManualZoom({ id: `zoom-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`, a, b: Math.min(duration, a + len), zoom, x: at.x, y: at.y }, duration);
}

export function fitManualZoom(m: ManualZoom, duration: number): ManualZoom {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const a = Math.max(0, Math.min(m.a, m.b, duration - MIN_REGION));
  const b = Math.min(duration, Math.max(m.a, m.b, a + MIN_REGION));
  return { ...m, a: r(a), b: r(b), zoom: Math.min(3, Math.max(1.1, m.zoom)), x: r(Math.min(1, Math.max(0, m.x))), y: r(Math.min(1, Math.max(0, m.y))) };
}

export function validManualZooms(v: unknown): ManualZoom[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((m): m is ManualZoom => typeof m === "object" && m !== null && typeof m.id === "string" && [m.a, m.b, m.zoom, m.x, m.y].every((n) => typeof n === "number" && Number.isFinite(n)))
    .map((m) => fitManualZoom(m, Number.POSITIVE_INFINITY));
}

/**
 * Zoom suggestions from the pointer: places where it comes to rest (stays within a small circle
 * for at least `dwell` seconds) after moving there. Each becomes a zoom on that spot, unless a
 * zoom is there already.
 */
export function suggestZooms(path: readonly Point[], duration: number, taken: readonly ZoomRegion[], opts: { zoom: number; dwell?: number; radius?: number } = { zoom: 1.8 }): ManualZoom[] {
  const dwell = opts.dwell ?? 1.2;
  const radius = opts.radius ?? 0.035;
  const out: ManualZoom[] = [];
  let i = 0;
  while (i < path.length) {
    const p = path[i]!;
    let j = i;
    let sx = 0;
    let sy = 0;
    // Grow the stay while the pointer remains near its first point.
    while (j < path.length && Math.hypot(path[j]!.x - p.x, path[j]!.y - p.y) <= radius) (sx += path[j]!.x), (sy += path[j]!.y), j++;
    // The pointer log has points only while it moves: the stay lasts until the next point.
    const end = j < path.length ? path[j]!.t : duration;
    const moved = i > 0 && Math.hypot(path[i - 1]!.x - p.x, path[i - 1]!.y - p.y) > radius * 0.5;
    if (end - p.t >= dwell && moved) {
      const a = Math.max(0, p.t - ZOOM_RAMP * 0.5);
      const b = Math.min(duration, Math.min(end, p.t + 4) + ZOOM_RAMP);
      const busy = [...taken, ...out.map(manualRegion)].some((r) => r.start < b && r.end > a);
      if (!busy && b - a >= MIN_REGION + 2 * ZOOM_RAMP) out.push(fitManualZoom({ id: `zoom-s${out.length}-${Math.round(p.t * 1000).toString(36)}`, a, b, zoom: opts.zoom, x: sx / (j - i), y: sy / (j - i) }, duration));
    }
    i = Math.max(i + 1, j);
  }
  return out;
}

/** Keys for the blocks: ease in, hold (gliding to each pan), ease out. */
export function regionKeys(regions: readonly ZoomRegion[]): ZoomKey[] {
  const keys: ZoomKey[] = [];
  for (const r of [...regions].sort((a, b) => a.start - b.start)) {
    const ramp = Math.min(ZOOM_RAMP, (r.end - r.start) / 3);
    let at = { fx: r.fx, fy: r.fy };
    keys.push({ t: r.start, z: 1, ...at }, { t: r.start + ramp, z: r.zoom, ...at });
    for (const p of (r.pans ?? []).filter((p) => p.t > r.start + ramp + 0.05 && p.t < r.end - ramp).sort((a, b) => a.t - b.t)) {
      keys.push({ t: Math.max(keys[keys.length - 1]!.t + 0.01, p.t - PAN_TIME), z: r.zoom, ...at });
      at = { fx: p.fx, fy: p.fy };
      keys.push({ t: p.t, z: r.zoom, ...at });
    }
    keys.push({ t: r.end - ramp, z: r.zoom, ...at }, { t: r.end, z: 1, ...at });
  }
  return keys;
}

/** Ease in and out (cubic). */
export const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

/** Zoom and anchor at time t (1 and the centre outside every block). */
export function viewAt(keys: readonly ZoomKey[], t: number): { z: number; fx: number; fy: number } {
  if (!keys.length || t <= keys[0]!.t) return { z: 1, fx: keys[0]?.fx ?? 0.5, fy: keys[0]?.fy ?? 0.5 };
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return { z: 1, fx: last.fx, fy: last.fy };
  let i = 1;
  while (keys[i]!.t < t) i++;
  const a = keys[i - 1]!;
  const b = keys[i]!;
  const k = ease((t - a.t) / Math.max(b.t - a.t, 1e-6));
  return { z: a.z + (b.z - a.z) * k, fx: a.fx + (b.fx - a.fx) * k, fy: a.fy + (b.fy - a.fy) * k };
}

/**
 * Where the zoomed view starts (0..1) on one axis: the anchor is brought to the middle, but the
 * view never leaves the picture, so a click near an edge shows everything around it.
 */
export function zoomView(focus: number, z: number): number {
  return Math.min(Math.max(focus - 0.5 / z, 0), 1 - 1 / z);
}

const n = (v: number) => (Math.round(v * 10000) / 10000).toString();

/** Sum of terms as a balanced tree (FFmpeg's parser nests deeply on long flat chains). */
function balancedSum(terms: string[]): string {
  if (terms.length === 0) return "0";
  let level = terms;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? `(${level[i]}+${level[i + 1]})` : level[i]!);
    level = next;
  }
  return level[0]!;
}

/**
 * FFmpeg expressions in `t` for the zoom and the anchor: the eased keys sampled into short straight
 * pieces (`step` seconds) inside the blocks; outside them the zoom is 1.
 */
export function viewExprs(keys: readonly ZoomKey[], step = 1 / 12): { z: string; fx: string; fy: string } {
  const z: string[] = [];
  const fx: string[] = [];
  const fy: string[] = [];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!;
    const b = keys[i]!;
    if (b.t <= a.t || (a.z <= 1.0001 && b.z <= 1.0001)) continue;
    const pieces = Math.max(1, Math.ceil((b.t - a.t) / step));
    for (let k = 0; k < pieces; k++) {
      const t0 = a.t + ((b.t - a.t) * k) / pieces;
      const t1 = a.t + ((b.t - a.t) * (k + 1)) / pieces;
      const v0 = viewAt(keys, t0 + 1e-9);
      const v1 = viewAt(keys, t1 - 1e-9);
      const gate = `between(t,${n(t0)},${n(t1)})*lt(t,${n(t1)})`;
      const line = (p: number, q: number, base: number) => {
        const slope = (q - p) / (t1 - t0);
        return Math.abs(slope) < 1e-9 ? `${gate}*${n(p - base)}` : `${gate}*(${n(p - base)}+(t-${n(t0)})*${slope.toFixed(6)})`;
      };
      z.push(line(v0.z, v1.z, 1));
      fx.push(line(v0.fx, v1.fx, 0.5));
      fy.push(line(v0.fy, v1.fy, 0.5));
    }
  }
  return { z: `(1+${balancedSum(z)})`, fx: `(0.5+${balancedSum(fx)})`, fy: `(0.5+${balancedSum(fy)})` };
}
