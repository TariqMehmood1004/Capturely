// What one export needs: the video's size and frame rate, the FFmpeg graph (core/exportGraph.ts)
// and the inputs it reads, numbered in the order they are added. Shapes are drawn to PNG and
// saved into the take first, so FFmpeg can lay them over the video.
import type { Pose } from "../core/cursor";
import type { TakeEdit } from "../core/edits";
import { buildExportGraph, type SoundInput } from "../core/exportGraph";
import { exportFps, exportScale, type ExportSettings } from "../core/exportSettings";
import { imageBox, shapeSvg } from "../core/marks";
import { layout } from "../core/style";
import type { Segment } from "../core/timeline";
import type { ZoomKey } from "../core/zoom";
import { platform, type ExportInput, type TakeData, type TakeInfo } from "../platform";
import { svgToPng } from "./media";

export interface ExportPlan {
  graph: string;
  inputs: ExportInput[];
  fps: number;
  width: number;
  height: number;
}

export async function planExport(o: {
  take: string;
  info: TakeInfo;
  data: TakeData;
  edit: TakeEdit;
  exp: ExportSettings;
  keys: readonly ZoomKey[];
  /** Clicks on the (cropped) picture, for the rings. */
  clicks: ReadonlyArray<{ t: number; x: number; y: number }>;
  /** The smooth cursor's poses, when it is drawn. */
  poses: readonly Pose[] | null;
  segs: readonly Segment[];
  font: string | null;
}): Promise<ExportPlan> {
  const { data, edit, exp, info } = o;
  const style = edit.style;
  const rec = { width: data.width, height: data.height };
  const full = layout(rec, style, 1);
  const L = layout(rec, style, exportScale(exp, full.out.width));
  const W = L.out.width;
  const H = L.out.height;
  const fps = exportFps(exp, data.fps);
  const gif = exp.format === "gif";
  const inputs: ExportInput[] = [];
  const add = (n: ExportInput) => inputs.push(n);

  const camera = style.camera.on && info.camera ? { look: style.camera, input: add("camera") } : null;
  const cursor = o.poses?.length && edit.cursor.on ? { poses: o.poses, look: edit.cursor, input: add("cursor") } : null;
  const frame = style.frame;
  const background = frame?.background === "image" && frame.image ? add(frame.image as ExportInput) : undefined;

  // Sound: the take's own (one mixed track, or system and microphone apart), then extra sound.
  const s = edit.sound;
  const sounds = info.sounds ?? [];
  const sound: SoundInput[] = gif
    ? []
    : [
        ...(sounds.length ? sounds.map((n) => ({ input: add(n), volume: n === "mic" ? s.mic : s.system, clean: n === "mic" && s.clean })) : info.audio ? [{ input: 0, volume: s.system, clean: s.clean }] : []),
        ...edit.audio.map((c) => ({ input: add(c.file as ExportInput), volume: c.volume, clean: false, delay: c.a, from: c.from, len: c.len })),
      ];

  // Pictures and shapes over the finished video.
  const overlays: Array<{ input: number; x: number; y: number; w: number; h: number; a: number; b: number }> = [];
  for (const m of edit.marks) {
    if (m.kind === "image" && m.file) overlays.push({ input: add(m.file as ExportInput), ...imageBox(m, W, H), a: m.a, b: m.b });
    if (m.kind === "shape") {
      const sv = shapeSvg(m, W, H);
      const png = await svgToPng(sv.svg, sv.w, sv.h);
      const name = `${m.id.toLowerCase().replace(/[^a-z0-9-]/g, "")}-${W}x${H}.png`.slice(-68);
      const ref = await platform.media.write(o.take, name, png);
      overlays.push({ input: add(ref as ExportInput), x: sv.x, y: sv.y, w: sv.w, h: sv.h, a: m.a, b: m.b });
    }
  }

  const graph = buildExportGraph({
    width: W,
    height: H,
    fps,
    box: L.box,
    crop: style.crop,
    keys: o.keys,
    rings: style.rings ? o.clicks : [],
    frame,
    background,
    camera,
    gif,
    segments: o.segs,
    sound,
    cursor,
    marks: edit.marks,
    font: o.font,
    overlays,
  });
  return { graph, inputs, fps, width: W, height: H };
}
