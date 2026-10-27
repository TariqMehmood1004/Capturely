// Export choices (format, quality, encoding, frame rate) and saved editor presets. Pure.
import type { ScreenFrame } from "./frame";
import { validFrame } from "./frame";
import { BUBBLE_SPOTS, type BubbleSpot } from "./recorder";
import type { AfterClick } from "./zoom";

export type ExportFormat = "mp4" | "gif";
export type ExportQuality = "low" | "medium" | "high" | "original";
export type ExportEncoding = "fast" | "balanced" | "quality";

export interface ExportSettings {
  format: ExportFormat;
  quality: ExportQuality;
  encoding: ExportEncoding;
  fps: number;
}

/** Share of the recording's size per quality. */
export const QUALITIES: ReadonlyArray<{ id: ExportQuality; label: string; scale: number }> = [
  { id: "low", label: "Low", scale: 0.6 },
  { id: "medium", label: "Medium", scale: 0.75 },
  { id: "high", label: "High", scale: 0.9 },
  { id: "original", label: "Original", scale: 1 },
];
export const ENCODINGS: ReadonlyArray<{ id: ExportEncoding; label: string }> = [
  { id: "fast", label: "Fast" },
  { id: "balanced", label: "Balanced" },
  { id: "quality", label: "Quality" },
];
/** Frame rates offered per format (a GIF stays light). */
export const FPS_CHOICES: Record<ExportFormat, readonly number[]> = { mp4: [24, 30, 60], gif: [10, 15, 24] };

export const DEFAULT_EXPORT: ExportSettings = { format: "mp4", quality: "original", encoding: "quality", fps: 60 };

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Output size for a quality: the recording scaled, even numbers (H.264 needs them). */
export function exportSize(width: number, height: number, quality: ExportQuality): { width: number; height: number } {
  const s = QUALITIES.find((q) => q.id === quality)?.scale ?? 1;
  return { width: even(width * s), height: even(height * s) };
}

/** The frame rate to use: the chosen one if this format offers it, else the nearest offered one
 *  that does not exceed the recording (a recording at 30 fps is not exported at 60). */
export function exportFps(s: ExportSettings, recordedFps: number): number {
  const offered = FPS_CHOICES[s.format];
  const pick = offered.includes(s.fps) ? s.fps : offered.reduce((a, b) => (Math.abs(b - s.fps) < Math.abs(a - s.fps) ? b : a));
  return Math.min(pick, Math.max(offered[0]!, recordedFps));
}

export function validExport(v: unknown): ExportSettings {
  const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  const format: ExportFormat = o.format === "gif" ? "gif" : "mp4";
  const quality = QUALITIES.some((q) => q.id === o.quality) ? (o.quality as ExportQuality) : DEFAULT_EXPORT.quality;
  const encoding = ENCODINGS.some((e) => e.id === o.encoding) ? (o.encoding as ExportEncoding) : DEFAULT_EXPORT.encoding;
  const fps = typeof o.fps === "number" && FPS_CHOICES[format].includes(o.fps) ? o.fps : format === "gif" ? 15 : DEFAULT_EXPORT.fps;
  return { format, quality, encoding, fps };
}

/** A saved look: zoom, cursor, frame, camera bubble and the export choices. */
export interface EditorPreset {
  name: string;
  zoom: { on: boolean; depth: number; hold: number; after: AfterClick };
  rings: boolean;
  frame: ScreenFrame | null;
  camera: { on: boolean; spot: BubbleSpot; size: number };
  export: ExportSettings;
}

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** A preset read back from storage, or null when it is not one. */
export function validPreset(v: unknown): EditorPreset | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const z = (typeof o.zoom === "object" && o.zoom !== null ? o.zoom : {}) as Record<string, unknown>;
  const c = (typeof o.camera === "object" && o.camera !== null ? o.camera : {}) as Record<string, unknown>;
  return {
    name,
    zoom: { on: z.on !== false, depth: num(z.depth, 1.2, 3, 1.8), hold: num(z.hold, 0.5, 4, 1.5), after: z.after === "zoomOut" ? "zoomOut" : "follow" },
    rings: o.rings !== false,
    frame: o.frame === null || o.frame === undefined ? null : (validFrame(o.frame) ?? null),
    camera: { on: c.on !== false, spot: BUBBLE_SPOTS.some((s) => s.id === c.spot) ? (c.spot as BubbleSpot) : "bottom-right", size: num(c.size, 0.12, 0.4, 0.22) },
    export: validExport(o.export),
  };
}

/** Saving under a name that exists replaces it (names compare without case); newest first. */
export function savePreset(list: readonly EditorPreset[], p: EditorPreset): EditorPreset[] {
  return [p, ...list.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase())].slice(0, 30);
}
