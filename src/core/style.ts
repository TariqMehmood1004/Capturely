// The take's look, saved with its edit (take.json): zoom settings, click rings, the background
// frame, the camera bubble, the video's shape (aspect ratio) and the crop. Also the layout both
// the preview and the export use: the output size, where the picture sits in it, and where the
// camera bubble goes. Pure.
import { validFrame, type ScreenFrame } from "./frame";
import { BUBBLE_SPOTS, type BubbleSpot } from "./recorder";
import type { AfterClick } from "./zoom";

export type Aspect = "auto" | "16:9" | "9:16" | "1:1" | "4:3" | "4:5";
export const ASPECTS: ReadonlyArray<{ id: Aspect; label: string; ratio: number | null }> = [
  { id: "auto", label: "Auto", ratio: null },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
];

/** Part of the recording kept, 0..1 of its width and height. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The camera bubble. `spot` "custom" places its centre at `x`, `y` (0..1 of the video). */
export interface CameraLook {
  on: boolean;
  spot: BubbleSpot | "custom";
  x: number;
  y: number;
  /** Width as a share of the video's width. */
  size: number;
  /** Space to the video's edge (share of its width), for the corner spots. */
  margin: number;
  /** 1 = a circle, 0 = a square. */
  round: number;
  shadow: number;
  mirror: boolean;
  /** Shrink the bubble while the picture is zoomed in. */
  zoomReact: boolean;
}

export interface ZoomLook {
  on: boolean;
  depth: number;
  hold: number;
  after: AfterClick;
}

export interface EditorStyle {
  zoom: ZoomLook;
  rings: boolean;
  frame: ScreenFrame | null;
  camera: CameraLook;
  aspect: Aspect;
  crop: Crop | null;
}

export const DEFAULT_CAMERA: CameraLook = { on: true, spot: "bottom-right", x: 0.85, y: 0.8, size: 0.22, margin: 0.03, round: 1, shadow: 0.4, mirror: true, zoomReact: false };
export const DEFAULT_ZOOM: ZoomLook = { on: true, depth: 1.8, hold: 1.5, after: "follow" };
export const DEFAULT_STYLE: EditorStyle = { zoom: DEFAULT_ZOOM, rings: true, frame: null, camera: DEFAULT_CAMERA, aspect: "auto", crop: null };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

export function validCamera(v: unknown, d: CameraLook = DEFAULT_CAMERA): CameraLook {
  const o = obj(v);
  return {
    on: typeof o.on === "boolean" ? o.on : d.on,
    spot: o.spot === "custom" || BUBBLE_SPOTS.some((s) => s.id === o.spot) ? (o.spot as CameraLook["spot"]) : d.spot,
    x: num(o.x, 0, 1, d.x),
    y: num(o.y, 0, 1, d.y),
    size: num(o.size, 0.08, 0.5, d.size),
    margin: num(o.margin, 0, 0.1, d.margin),
    round: num(o.round, 0, 1, d.round),
    shadow: num(o.shadow, 0, 1, d.shadow),
    mirror: typeof o.mirror === "boolean" ? o.mirror : d.mirror,
    zoomReact: typeof o.zoomReact === "boolean" ? o.zoomReact : d.zoomReact,
  };
}

export function validCrop(v: unknown): Crop | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const x = num(o.x, 0, 0.9, 0);
  const y = num(o.y, 0, 0.9, 0);
  const w = num(o.w, 0.1, 1 - x, 1 - x);
  const h = num(o.h, 0.1, 1 - y, 1 - y);
  return x < 1e-4 && y < 1e-4 && w > 0.9999 && h > 0.9999 ? null : { x, y, w, h };
}

/** A saved look, or `fallback` (the recorder's choices for a take never edited) where missing. */
export function validStyle(v: unknown, fallback: EditorStyle = DEFAULT_STYLE): EditorStyle {
  const o = obj(v);
  const z = obj(o.zoom);
  const fz = fallback.zoom;
  return {
    zoom: { on: typeof z.on === "boolean" ? z.on : fz.on, depth: num(z.depth, 1.2, 3, fz.depth), hold: num(z.hold, 0.5, 4, fz.hold), after: z.after === "zoomOut" || z.after === "follow" ? z.after : fz.after },
    rings: typeof o.rings === "boolean" ? o.rings : fallback.rings,
    frame: o.frame === null ? null : o.frame === undefined ? fallback.frame : (validFrame(o.frame) ?? null),
    camera: validCamera(o.camera, fallback.camera),
    aspect: ASPECTS.some((a) => a.id === o.aspect) ? (o.aspect as Aspect) : fallback.aspect,
    crop: o.crop === undefined ? fallback.crop : validCrop(o.crop),
  };
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export interface Layout {
  /** The video's size. */
  out: { width: number; height: number };
  /** Where the picture sits in it (pixels), and its corner radius. */
  box: { x: number; y: number; w: number; h: number; radius: number };
  /** The picture needs a background around it (a frame, or bars for another shape). */
  framed: boolean;
}

/**
 * The video's size and the picture's place in it. `rec` is the recording's size, `scale` the
 * export quality. Without a frame or a chosen shape, the picture is the whole video.
 */
export function layout(rec: { width: number; height: number }, style: Pick<EditorStyle, "frame" | "aspect" | "crop">, scale = 1): Layout {
  const c = style.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const pw = rec.width * c.w * scale;
  const ph = rec.height * c.h * scale;
  const ratio = ASPECTS.find((a) => a.id === style.aspect)?.ratio ?? null;
  // The video keeps the picture's longer side and takes the chosen shape around it.
  let W = pw;
  let H = ph;
  if (ratio) {
    if (pw / ph > ratio) H = pw / ratio;
    else W = ph * ratio;
  }
  W = even(W);
  H = even(H);
  const f = style.frame;
  const framed = !!f || (!!ratio && Math.abs(W / H - pw / ph) > 0.002);
  if (!framed) return { out: { width: W, height: H }, box: { x: 0, y: 0, w: W, h: H, radius: 0 }, framed: false };
  const p = f?.padding ?? 0;
  // The picture fits inside the space left by the padding, keeping its own shape.
  const iw = W * (1 - 2 * p);
  const ih = H * (1 - 2 * p);
  const k = Math.min(iw / pw, ih / ph);
  const w = even(pw * k);
  const h = even(ph * k);
  const x = Math.round((W - w) / 2);
  const y = Math.round((H - h) / 2);
  return { out: { width: W, height: H }, box: { x, y, w, h, radius: f ? Math.round(f.radius * Math.min(w, h)) : 0 }, framed: true };
}

/** Recording positions (0..1) as positions on the cropped picture. */
export function cropPoint<T extends { x: number; y: number }>(p: T, crop: Crop | null): T {
  if (!crop) return p;
  return { ...p, x: (p.x - crop.x) / crop.w, y: (p.y - crop.y) / crop.h };
}

/** How much the bubble shrinks at zoom `z` (zoom-reactive bubbles). */
export const camReact = (z: number): number => 1 / (1 + 0.5 * Math.max(0, z - 1));

/**
 * The bubble's size and place in a W×H video: `size` px square; it hangs from a corner (`ax`,
 * `ay` and the margin `m`) or, for a custom spot, from its centre (`cx`, `cy`). When it shrinks
 * (zoom-reactive) it stays on its anchor.
 */
export function cameraBox(c: CameraLook, W: number, H: number): { size: number; m: number; ax: "left" | "right" | "center"; ay: "top" | "bottom" | "center"; cx: number; cy: number; x: number; y: number } {
  const size = even(W * c.size);
  const m = Math.round(W * c.margin);
  if (c.spot === "custom") {
    const cx = Math.round(Math.min(W - size / 2, Math.max(size / 2, c.x * W)));
    const cy = Math.round(Math.min(H - size / 2, Math.max(size / 2, c.y * H)));
    return { size, m, ax: "center", ay: "center", cx, cy, x: cx - size / 2, y: cy - size / 2 };
  }
  const right = c.spot.endsWith("right");
  const bottom = c.spot.startsWith("bottom");
  const x = right ? W - size - m : m;
  const y = bottom ? H - size - m : m;
  return { size, m, ax: right ? "right" : "left", ay: bottom ? "bottom" : "top", cx: x + size / 2, cy: y + size / 2, x, y };
}
