// The export's FFmpeg filter graph: the recording (input 0) with smooth click zooms, click rings,
// an optional background frame, and the camera (input 1) as a round bubble. Output label [vout].
// Built as one argument for -filter_complex_script (never a shell string). Pure.
import { frameChains, type ScreenFrame } from "./frame";
import type { BubbleSpot } from "./recorder";
import { viewAt, viewExprs, zoomView, type ZoomKey } from "./zoom";

export interface ExportOptions {
  /** Output size (even numbers) and frame rate. */
  width: number;
  height: number;
  fps: number;
  /** Zoom keys (core/zoom.ts); empty = no zoom. */
  keys: readonly ZoomKey[];
  /** Click rings at these clicks (seconds of the recording, 0..1 positions); empty = none. */
  rings: ReadonlyArray<{ t: number; x: number; y: number }>;
  frame: ScreenFrame | null;
  camera: { spot: BubbleSpot; size: number } | null;
}

/** How long a click ring shows, and its diameter (share of the picture's shorter side). */
export const RING_TIME = 0.45;
const RING_SIZE = 0.06;

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const f4 = (v: number) => (Math.round(v * 10000) / 10000).toString();

/** A still, drawn once and repeated, as a stream at `fps` (cheap per frame). */
const still = (lum: string, w: number, h: number, fps: number) => `color=c=black:s=${w}x${h}:r=${fps}:d=${f4(1 / fps)},format=gray,geq=lum='${lum}',loop=loop=-1:size=1,setpts=N/${fps}/TB`;

export function buildExportGraph(o: ExportOptions): string {
  const W = even(o.width);
  const H = even(o.height);
  const F = o.fps;
  const chains: string[] = [`[0:v]fps=${F},scale=${W}:${H}:flags=lanczos,setsar=1,format=yuv420p[src]`];
  let last = "[src]";

  // Smooth zooms, centred on the click as far as the picture allows (zoom.ts zoomView).
  if (o.keys.some((k) => k.z > 1.0001)) {
    const e = viewExprs(o.keys);
    const z = `max(1,${e.z})`;
    chains.push(`${last}split=2[zb][zs]`);
    chains.push(`[zs]scale=w='2*trunc(${W}*${z}/2)':h='2*trunc(${H}*${z}/2)':eval=frame:flags=lanczos,setsar=1[zbig]`);
    chains.push(`[zb][zbig]overlay=x='max(W-w,min(0,W/2-(${e.fx})*w))':y='max(H-h,min(0,H/2-(${e.fy})*h))':eval=frame[zoomed]`);
    last = "[zoomed]";
  }

  // Click rings where the clicks land in the (zoomed) picture.
  const D = even(Math.min(W, H) * RING_SIZE);
  const rings = o.rings
    .map((c) => {
      const v = viewAt(o.keys, c.t);
      const x = (c.x - zoomView(v.fx, v.z)) * v.z * W;
      const y = (c.y - zoomView(v.fy, v.z)) * v.z * H;
      return { t: c.t, x: Math.round(x - D / 2), y: Math.round(y - D / 2) };
    })
    .filter((r) => r.x > -D && r.y > -D && r.x < W && r.y < H);
  if (rings.length) {
    const r = D / 2;
    const ring = `255*between(hypot(X-${r},Y-${r}),${r - Math.max(2, D / 12)},${r - 1})`;
    chains.push(`${still(ring, D, D, F)}[rm]`, `color=c=0xf43f5e:s=${D}x${D}:r=${F},format=yuva420p[rc]`, `[rc][rm]alphamerge,split=${rings.length}${rings.map((_, i) => `[ring${i}]`).join("")}`);
    rings.forEach((g, i) => {
      chains.push(`${last}[ring${i}]overlay=x=${g.x}:y=${g.y}:enable='between(t,${f4(g.t)},${f4(g.t + RING_TIME)})'[rg${i}]`);
      last = `[rg${i}]`;
    });
  }

  if (o.frame) last = frameChains(chains, o.frame, { width: W, height: H }, F, last);

  // The camera as a round bubble in its corner (mirrored, as the recorder showed it).
  if (o.camera) {
    const B = even(W * o.camera.size);
    const m = Math.round(W * 0.03);
    const x = o.camera.spot.endsWith("right") ? W - B - m : m;
    const y = o.camera.spot.startsWith("bottom") ? H - B - m : m;
    const r = B / 2;
    chains.push(`${still(`255*lte(hypot(X-${r}+0.5,Y-${r}+0.5),${r})`, B, B, F)}[cm]`);
    chains.push(`[1:v]fps=${F},crop='min(iw,ih)':'min(iw,ih)',scale=${B}:${B}:flags=lanczos,hflip,format=yuva420p[cv]`, `[cv][cm]alphamerge[cam]`);
    chains.push(`${last}[cam]overlay=x=${x}:y=${y}:eof_action=pass[withcam]`);
    last = "[withcam]";
  }

  chains.push(`${last}format=yuv420p[vout]`);
  return chains.join(";\n");
}
