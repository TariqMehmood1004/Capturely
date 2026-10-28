// The export's FFmpeg filter graph: the recording (input 0) with blurs, the smooth cursor, smooth
// click zooms, click rings, an optional background frame, the camera as a round bubble and text
// labels, then cuts and speed-ups. Output label [vout] (yuv420p for MP4, or paletted for a GIF),
// and [aout] for the sound when there is any (volumes, noise cleanup, the same cuts).
// Other inputs (camera, cursor image, separate sound tracks) are numbered by the caller.
// Built as one argument for -filter_complex_script (never a shell string). Pure.
import { cursorChains, type CursorLook } from "./cursor";
import type { Span } from "./edits";
import { frameChains, type ScreenFrame } from "./frame";
import { blurChains, textChains, type Mark } from "./marks";
import { audioTimeChain, isPlain, segments, videoTimeChain, type Segment } from "./timeline";
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
  /** The camera bubble; `input` is the camera's input number (1 when not given). */
  camera: { spot: BubbleSpot; size: number; input?: number } | null;
  /** A GIF: the picture ends in a palette made from the whole clip (no audio). */
  gif?: boolean;
  /** Stretches left out (recording seconds) and the recording's length; with `audio` the sound
   *  is trimmed the same way into [aout]. `segments` (core/timeline.ts) also speeds parts up. */
  cuts?: readonly Span[];
  duration?: number;
  segments?: readonly Segment[];
  /** The recording's own sound as is (when `sound` is not given). */
  audio?: boolean;
  /** Sounds to mix: input number (0 = the recording), volume (1 = as recorded), noise cleanup. */
  sound?: ReadonlyArray<{ input: number; volume: number; clean: boolean }>;
  /** The smooth cursor: its track (core/cursor.ts), look, and the cursor image's input number. */
  cursor?: { track: ReadonlyArray<{ x: number; y: number }>; look: CursorLook; input: number } | null;
  /** Blur and text (core/marks.ts); text needs a font file. */
  marks?: readonly Mark[];
  font?: string | null;
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

  // Blurs and the cursor belong to the recording, so they zoom with it.
  if (o.marks?.length) last = blurChains(chains, o.marks, last, W, H);
  if (o.cursor) last = cursorChains(chains, o.cursor.track, o.cursor.look, o.cursor.input, last, W, H);

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
    chains.push(`[${o.camera.input ?? 1}:v]fps=${F},crop='min(iw,ih)':'min(iw,ih)',scale=${B}:${B}:flags=lanczos,hflip,format=yuva420p[cv]`, `[cv][cm]alphamerge[cam]`);
    chains.push(`${last}[cam]overlay=x=${x}:y=${y}:eof_action=pass[withcam]`);
    last = "[withcam]";
  }

  // Labels sit on the finished picture.
  if (o.marks?.length && o.font) last = textChains(chains, o.marks, o.font, last, W, H);

  // Cuts and speed-ups last, so every effect above still runs on the recording's own clock.
  const segs = o.segments ?? (o.cuts?.length && o.duration ? segments(o.duration, o.cuts) : []);
  const timed = segs.length > 0 && !isPlain(segs);
  if (timed) {
    chains.push(videoTimeChain(segs, F, last, "[kept]"));
    last = "[kept]";
  }

  // Sound: each source at its volume (cleaned up if asked), mixed, then cut like the picture.
  const sound = o.sound ?? (o.audio ? [{ input: 0, volume: 1, clean: false }] : []);
  const plainSound = sound.length === 1 && sound[0]!.input === 0 && sound[0]!.volume === 1 && !sound[0]!.clean;
  if (sound.length && !o.gif && (timed || !plainSound)) {
    const labels = sound.map((x, i) => {
      chains.push(`[${x.input}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${f4(x.volume)}${x.clean ? ",afftdn=nf=-25:tn=1" : ""}[snd${i}]`);
      return `[snd${i}]`;
    });
    const mixed = labels.length > 1 ? "[mixed]" : labels[0]!;
    if (labels.length > 1) chains.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0[mixed]`);
    chains.push(timed ? audioTimeChain(segs, mixed, "[aout]") : `${mixed}anull[aout]`);
  }

  if (o.gif) chains.push(`${last}split[gp][gu]`, `[gp]palettegen=stats_mode=diff[pal]`, `[gu][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle[vout]`);
  else chains.push(`${last}format=yuv420p[vout]`);
  return chains.join(";\n");
}
