// The export's FFmpeg filter graph: the recording (input 0), cropped, with blurs, the smooth
// cursor, smooth zooms and click rings; then put in its frame (or on bars for another shape), the
// camera bubble, pictures and shapes, and text labels; then cuts and speed changes. Output label
// [vout] (yuv420p for MP4, or paletted for a GIF), and [aout] for the sound when there is any
// (volumes, noise cleanup, extra sound, the same cuts and speed changes).
// Other inputs (camera, cursor image, pictures, sound files) are numbered by the caller.
// Built as one argument for -filter_complex_script (never a shell string). Pure.
import { cursorChains, type CursorLook, type Pose } from "./cursor";
import type { Span } from "./edits";
import { frameChains, PLAIN_FRAME, roundedMask, stillMask, type ScreenFrame } from "./frame";
import { blurChains, overlayChains, textChains, type Mark } from "./marks";
import { cameraBox, type CameraLook, type Crop } from "./style";
import { audioTimeChain, isPlain, segments, videoTimeChain, type Segment } from "./timeline";
import { viewAt, viewExprs, zoomView, type ZoomKey } from "./zoom";

/** A sound to mix: its input, volume (1 = as recorded) and noise cleanup; extra sound also starts
 *  `delay` seconds into the recording and uses `len` seconds from `from` seconds into its file. */
export interface SoundInput {
  input: number;
  volume: number;
  clean: boolean;
  delay?: number;
  from?: number;
  len?: number;
}

export interface ExportOptions {
  /** The video's size (even numbers) and frame rate. */
  width: number;
  height: number;
  fps: number;
  /** Where the picture sits in the video and its corner radius (core/style.ts layout); the whole
   *  video when not given. */
  box?: { x: number; y: number; w: number; h: number; radius: number };
  /** Part of the recording kept (0..1), cut out before anything else. */
  crop?: Crop | null;
  /** Zoom keys (core/zoom.ts); empty = no zoom. */
  keys: readonly ZoomKey[];
  /** Click rings at these clicks (seconds of the recording, 0..1 of the picture); empty = none. */
  rings: ReadonlyArray<{ t: number; x: number; y: number }>;
  frame: ScreenFrame | null;
  /** The input number of a picture background (frames with `background: "image"`). */
  background?: number;
  /** The camera bubble and the camera's input number (1 when not given). */
  camera: { look: CameraLook; input?: number } | null;
  /** A GIF: the picture ends in a palette made from the whole clip (no audio). */
  gif?: boolean;
  /** Stretches left out (recording seconds) and the recording's length; with `audio` the sound
   *  is trimmed the same way into [aout]. `segments` (core/timeline.ts) also changes speeds. */
  cuts?: readonly Span[];
  duration?: number;
  segments?: readonly Segment[];
  /** The recording's own sound as is (when `sound` is not given). */
  audio?: boolean;
  /** Sounds to mix (input 0 = the recording). */
  sound?: readonly SoundInput[];
  /** The smooth cursor: its poses (core/cursor.ts), look, and the cursor image's input number. */
  cursor?: { poses: readonly Pose[]; look: CursorLook; input: number } | null;
  /** Blur and text (core/marks.ts); text needs a font file. */
  marks?: readonly Mark[];
  font?: string | null;
  /** Pictures over the finished video: picture marks and shapes rendered to PNG. */
  overlays?: ReadonlyArray<{ input: number; x: number; y: number; w: number; h: number; a: number; b: number }>;
}

/** How long a click ring shows, and its diameter (share of the picture's shorter side). */
export const RING_TIME = 0.45;
const RING_SIZE = 0.06;

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const f4 = (v: number) => (Math.round(v * 10000) / 10000).toString();

export function buildExportGraph(o: ExportOptions): string {
  const W = even(o.width);
  const H = even(o.height);
  const F = o.fps;
  const box = o.box ?? { x: 0, y: 0, w: W, h: H, radius: 0 };
  const framed = !!o.frame || box.w !== W || box.h !== H;
  // The picture's own size: the effects below run on it, before it goes into the frame.
  const PW = framed ? even(box.w) : W;
  const PH = framed ? even(box.h) : H;
  const c = o.crop;
  const crop = c ? `crop=w=iw*${f4(c.w)}:h=ih*${f4(c.h)}:x=iw*${f4(c.x)}:y=ih*${f4(c.y)},` : "";
  const chains: string[] = [`[0:v]fps=${F},${crop}scale=${PW}:${PH}:flags=lanczos,setsar=1,format=yuv420p[src]`];
  let last = "[src]";

  // Blurs and the cursor belong to the recording, so they zoom with it.
  if (o.marks?.length) last = blurChains(chains, o.marks, last, PW, PH);
  if (o.cursor) last = cursorChains(chains, o.cursor.poses, o.cursor.look, o.cursor.input, last, PW, PH, F);

  // Smooth zooms, centred on the click as far as the picture allows (zoom.ts zoomView).
  const zoomed = o.keys.some((k) => k.z > 1.0001);
  const e = zoomed ? viewExprs(o.keys) : null;
  if (e) {
    const z = `max(1,${e.z})`;
    chains.push(`${last}split=2[zb][zs]`);
    chains.push(`[zs]scale=w='2*trunc(${PW}*${z}/2)':h='2*trunc(${PH}*${z}/2)':eval=frame:flags=lanczos,setsar=1[zbig]`);
    chains.push(`[zb][zbig]overlay=x='max(W-w,min(0,W/2-(${e.fx})*w))':y='max(H-h,min(0,H/2-(${e.fy})*h))':eval=frame[zoomed]`);
    last = "[zoomed]";
  }

  // Click rings where the clicks land in the (zoomed) picture.
  const D = even(Math.min(PW, PH) * RING_SIZE);
  const rings = o.rings
    .map((p) => {
      const v = viewAt(o.keys, p.t);
      const x = (p.x - zoomView(v.fx, v.z)) * v.z * PW;
      const y = (p.y - zoomView(v.fy, v.z)) * v.z * PH;
      return { t: p.t, x: Math.round(x - D / 2), y: Math.round(y - D / 2) };
    })
    .filter((r) => r.x > -D && r.y > -D && r.x < PW && r.y < PH);
  if (rings.length) {
    const r = D / 2;
    const ring = `255*between(hypot(X-${r},Y-${r}),${r - Math.max(2, D / 12)},${r - 1})`;
    chains.push(`${stillMask(ring, D, D, F)}[rm]`, `color=c=0xf43f5e:s=${D}x${D}:r=${F},format=yuva420p[rc]`, `[rc][rm]alphamerge,split=${rings.length}${rings.map((_, i) => `[ring${i}]`).join("")}`);
    rings.forEach((g, i) => {
      chains.push(`${last}[ring${i}]overlay=x=${g.x}:y=${g.y}:enable='between(t,${f4(g.t)},${f4(g.t + RING_TIME)})'[rg${i}]`);
      last = `[rg${i}]`;
    });
  }

  if (framed) last = frameChains(chains, o.frame ?? PLAIN_FRAME, { width: W, height: H }, { ...box, w: PW, h: PH }, F, last, o.background);

  if (o.camera) last = cameraChains(chains, o.camera.look, o.camera.input ?? 1, last, W, H, F, e ? `max(1,${e.z})` : null);

  // Pictures, shapes and labels sit on the finished video.
  if (o.overlays?.length) last = overlayChains(chains, o.overlays, last);
  if (o.marks?.length && o.font) last = textChains(chains, o.marks, o.font, last, W, H);

  // Cuts and speed changes last, so every effect above still runs on the recording's own clock.
  const segs = o.segments ?? (o.cuts?.length && o.duration ? segments(o.duration, o.cuts) : []);
  const timed = segs.length > 0 && !isPlain(segs);
  if (timed) {
    chains.push(videoTimeChain(segs, F, last, "[kept]"));
    last = "[kept]";
  }

  // Sound: each source at its volume (cleaned up, placed in time if asked), mixed, then cut and
  // sped like the picture.
  const sound = o.sound ?? (o.audio ? [{ input: 0, volume: 1, clean: false }] : []);
  const plainSound = sound.length === 1 && sound[0]!.input === 0 && sound[0]!.volume === 1 && !sound[0]!.clean && !sound[0]!.delay && sound[0]!.len === undefined;
  if (sound.length && !o.gif && (timed || !plainSound)) {
    const labels = sound.map((x, i) => {
      const trim = x.len !== undefined ? `atrim=start=${f4(x.from ?? 0)}:duration=${f4(x.len)},asetpts=PTS-STARTPTS,` : "";
      const delay = x.delay && x.delay > 0.0005 ? `,adelay=${Math.round(x.delay * 1000)}:all=1` : "";
      chains.push(`[${x.input}:a]${trim}aresample=48000,aformat=channel_layouts=stereo,volume=${f4(x.volume)}${x.clean ? ",afftdn=nf=-25:tn=1" : ""}${delay}[snd${i}]`);
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

/**
 * The camera bubble on `input` (the W×H video): a square from the middle of the camera picture,
 * rounded (a circle at `round` 1), mirrored if asked, with a soft shadow. With `zoom` (an FFmpeg
 * expression of the zoom over time) a zoom-reactive bubble shrinks while the picture is zoomed in,
 * staying on its corner or centre. Returns the output label.
 */
export function cameraChains(chains: string[], look: CameraLook, camera: number, input: string, W: number, H: number, F: number, zoom: string | null): string {
  const cb = cameraBox(look, W, H);
  const B = cb.size;
  const r = Math.round((look.round * B) / 2);
  chains.push(`${stillMask(roundedMask(r), B, B, F)}[cm]`);
  chains.push(`[${camera}:v]fps=${F},crop='min(iw,ih)':'min(iw,ih)',scale=${B}:${B}:flags=lanczos${look.mirror ? ",hflip" : ""},format=yuva420p[cv]`, `[cv][cm]alphamerge[cam]`);
  // The bubble sits at (ox, oy) in a picture P×Q that has room for its shadow.
  let bubble = "[cam]";
  let P = B;
  let Q = B;
  let ox = 0;
  let oy = 0;
  if (look.shadow > 0.01) {
    const sm = Math.round(B * 0.12);
    const drop = Math.round(sm * 0.35);
    P = B + 2 * sm;
    Q = B + 2 * sm;
    ox = sm;
    oy = sm - drop;
    chains.push(
      `${stillMask(roundedMask(r), B, B, F)},pad=${P}:${Q}:${sm}:${sm}:black,gblur=sigma=${(sm / 2.5).toFixed(2)}[csm]`,
      `color=c=black:s=${P}x${Q}:r=${F},format=yuva420p[csc]`,
      `[csc][csm]alphamerge,colorchannelmixer=aa=${(0.7 * look.shadow).toFixed(3)}[csh]`,
      `[csh][cam]overlay=x=${ox}:y=${oy}:format=auto:shortest=1[camsh]`,
    );
    bubble = "[camsh]";
  }
  const react = look.zoomReact && zoom;
  if (react) {
    // camReact (core/style.ts): 1 / (1 + 0.5 (z - 1)).
    const k = `(1/(1+0.5*(${zoom}-1)))`;
    chains.push(`${bubble}scale=w='2*trunc(${P}*${k}/2)':h='2*trunc(${Q}*${k}/2)':eval=frame:flags=bilinear[camz]`);
    bubble = "[camz]";
  }
  // Where the picture goes so the bubble keeps its anchor; `w`/`h` are the (scaled) picture's size.
  const at = (anchor: string, m: number, c: number, size: number, off: number, full: number, v: "w" | "h", big: "W" | "H") => {
    if (!react) {
      if (anchor === "left" || anchor === "top") return String(m - off);
      if (anchor === "right" || anchor === "bottom") return String(full - m - size - off);
      return String(Math.round(c - size / 2 - off));
    }
    const share = (n: number) => f4(n / (v === "w" ? P : Q));
    if (anchor === "left" || anchor === "top") return `'${m}-${v}*${share(off)}'`;
    if (anchor === "right" || anchor === "bottom") return `'${big}-${m}-${v}*${share(size + off)}'`;
    return `'${c}-${v}*${share(off + size / 2)}'`;
  };
  const x = at(cb.ax, cb.m, cb.cx, B, ox, W, "w", "W");
  const y = at(cb.ay, cb.m, cb.cy, B, oy, H, "h", "H");
  chains.push(`${input}${bubble}overlay=x=${x}:y=${y}${react ? ":eval=frame" : ""}:eof_action=pass[withcam]`);
  return "[withcam]";
}
