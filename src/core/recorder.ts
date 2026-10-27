// Recorder helpers: the recording format, the camera bubble's corners, and the click log mapped
// onto the recorded picture. Pure.

/** Formats MediaRecorder is asked for, best first (WebView2 / Chromium record WebM). */
export const RECORDING_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

export function recordingType(isSupported: (t: string) => boolean): string | null {
  return RECORDING_TYPES.find(isSupported) ?? null;
}

export type BubbleSpot = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export const BUBBLE_SPOTS: ReadonlyArray<{ id: BubbleSpot; label: string }> = [
  { id: "bottom-right", label: "Bottom right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "top-right", label: "Top right" },
  { id: "top-left", label: "Top left" },
];

/** A click or pointer position from the click log: ms since the recording started, screen pixels. */
export interface ScreenClick {
  ms: number;
  x: number;
  y: number;
}

/** The recorded area in screen pixels. */
export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Screen points as recording time (seconds, without paused time) and positions on the recorded
 * picture (0..1). Points outside the area or while paused are left out.
 */
export function onRecording(points: readonly ScreenClick[], area: MonitorRect, pauses: ReadonlyArray<{ a: number; b: number }>): Array<{ t: number; x: number; y: number }> {
  const out: Array<{ t: number; x: number; y: number }> = [];
  for (const c of points) {
    const inside = c.x >= area.x && c.x < area.x + area.width && c.y >= area.y && c.y < area.y + area.height;
    if (!inside || pauses.some((p) => c.ms >= p.a && c.ms < p.b)) continue;
    const paused = pauses.reduce((sum, p) => sum + (p.b <= c.ms ? p.b - p.a : 0), 0);
    out.push({ t: (c.ms - paused) / 1000, x: (c.x - area.x) / area.width, y: (c.y - area.y) / area.height });
  }
  return out;
}
