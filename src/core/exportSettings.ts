// Export choices (format, quality, encoding, frame rate, GIF size and looping) and saved editor
// presets (the take's look and the export choices). Pure.
import { DEFAULT_CURSOR, validCursor, type CursorLook } from "./cursor";
import { DEFAULT_STYLE, validStyle, type EditorStyle } from "./style";

export type ExportFormat = "mp4" | "gif";
export type ExportQuality = "low" | "medium" | "high" | "original";
export type ExportEncoding = "fast" | "balanced" | "quality";

export interface ExportSettings {
  format: ExportFormat;
  quality: ExportQuality;
  encoding: ExportEncoding;
  fps: number;
  /** GIF: the width at most (0 = the video's own), and whether it plays again and again. */
  gifWidth: number;
  gifLoop: boolean;
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
/** GIF widths offered (0 = as large as the video). */
export const GIF_WIDTHS = [480, 640, 800, 1024, 0] as const;

export const DEFAULT_EXPORT: ExportSettings = { format: "mp4", quality: "original", encoding: "quality", fps: 60, gifWidth: 800, gifLoop: true };

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Output size for a quality: the recording scaled, even numbers (H.264 needs them). */
export function exportSize(width: number, height: number, quality: ExportQuality): { width: number; height: number } {
  const s = qualityScale(quality);
  return { width: even(width * s), height: even(height * s) };
}

export const qualityScale = (quality: ExportQuality): number => QUALITIES.find((q) => q.id === quality)?.scale ?? 1;

/**
 * How much to scale the recording for this export: the quality for an MP4; for a GIF, small
 * enough that the video (`fullWidth` wide at scale 1) is at most the chosen GIF width.
 */
export function exportScale(s: ExportSettings, fullWidth: number): number {
  if (s.format !== "gif") return qualityScale(s.quality);
  return s.gifWidth > 0 && fullWidth > s.gifWidth ? s.gifWidth / fullWidth : 1;
}

/** The frame rate to use: the chosen one if this format offers it, else the nearest offered one
 *  that does not exceed the recording (a recording at 30 fps is not exported at 60). */
export function exportFps(s: Pick<ExportSettings, "format" | "fps">, recordedFps: number): number {
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
  const gifWidth = typeof o.gifWidth === "number" && (GIF_WIDTHS as readonly number[]).includes(o.gifWidth) ? o.gifWidth : DEFAULT_EXPORT.gifWidth;
  return { format, quality, encoding, fps, gifWidth, gifLoop: o.gifLoop !== false };
}

/** A saved look: zoom, rings, frame, camera bubble, shape (not the crop: it belongs to one
 *  recording), the cursor's look and the export choices. */
export interface EditorPreset {
  name: string;
  style: Omit<EditorStyle, "crop">;
  cursor: CursorLook;
  export: ExportSettings;
}

/** A preset read back from storage, or null when it is not one. Presets saved before the look
 *  had its own field kept zoom, rings, frame and camera at the top. */
export function validPreset(v: unknown): EditorPreset | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const old = typeof o.style === "object" && o.style !== null ? o.style : { zoom: o.zoom, rings: o.rings, frame: o.frame ?? null, camera: o.camera };
  const { crop: _crop, ...style } = validStyle(old, DEFAULT_STYLE);
  return { name, style, cursor: o.cursor === undefined ? DEFAULT_CURSOR : validCursor(o.cursor), export: validExport(o.export) };
}

/** Saving under a name that exists replaces it (names compare without case); newest first. */
export function savePreset(list: readonly EditorPreset[], p: EditorPreset): EditorPreset[] {
  return [p, ...list.filter((x) => x.name.toLowerCase() !== p.name.toLowerCase())].slice(0, 30);
}
