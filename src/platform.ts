// The only place that talks to the Rust side (Tauri commands and events). Screens use these
// functions; nothing else imports @tauri-apps.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { MonitorRect, ScreenClick } from "./core/recorder";

export interface CaptureTargets {
  monitors: Array<{ index: number; name: string; x: number; y: number; width: number; height: number; primary: boolean }>;
  windows: Array<{ id: string; title: string }>;
}

export interface CaptureSpec {
  kind: "monitor" | "window";
  monitor?: number;
  window?: string;
  fps: number;
  cursor: boolean;
  systemAudio: boolean;
}

export interface TakeInfo {
  path: string;
  name: string;
  data: TakeData | null;
  video: string | null;
  camera: string | null;
  exports: string[];
  bytes: number;
  modified: number;
}

/** take.json: what the recorder knew (times are seconds of the recording). */
export interface TakeData {
  version: 1;
  createdAt: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  source: "monitor" | "window";
  clicks: Array<{ t: number; x: number; y: number }>;
  path: Array<{ t: number; x: number; y: number }>;
  markers: number[];
  zoom: { on: boolean; depth: number; hold: number; after: "follow" | "zoomOut" };
  ripples: boolean;
  camera: { spot: "bottom-right" | "bottom-left" | "top-right" | "top-left"; size: number } | null;
}

export interface HudStatus {
  elapsed: number;
  paused: boolean;
  markers: number;
}
export type HudCommand = "pause" | "resume" | "stop" | "marker" | "restart";

/** A job: a promise and a way to cancel it; progress arrives as 0..1. */
export interface Job<T> {
  promise: Promise<T>;
  cancel: () => Promise<void>;
  onProgress: (cb: (p: number) => void) => Promise<() => void>;
}

let jobCounter = 0;
function job<T>(run: (jobId: string) => Promise<T>): Job<T> {
  const jobId = `job-${Date.now().toString(36)}-${(jobCounter++).toString(36)}`;
  return {
    promise: run(jobId),
    cancel: () => invoke<boolean>("cancel_job", { jobId }).then(() => undefined),
    onProgress: (cb) => listen<{ jobId: string; progress: number }>("job-progress", (e) => e.payload.jobId === jobId && cb(e.payload.progress)),
  };
}

export const errorMessage = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : "Something went wrong.");

export const platform = {
  windowLabel: (): string => getCurrentWindow().label,
  mediaUrl: (path: string) => convertFileSrc(path),
  reveal: (path: string) => revealItemInDir(path),
  window: {
    minimize: () => getCurrentWindow().minimize(),
    restore: async () => {
      const w = getCurrentWindow();
      await w.unminimize();
      await w.setFocus();
    },
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
  },

  captureTargets: () => invoke<CaptureTargets>("capture_targets"),
  captureStart: (spec: CaptureSpec) => invoke<MonitorRect>("capture_start", { spec }),
  capturePause: (paused: boolean) => invoke<void>("capture_pause", { paused }),
  captureCancel: () => invoke<void>("capture_cancel"),
  captureFinish: (mic: string | null, take: string, duration: number) => job((jobId) => invoke<string>("capture_finish", { jobId, mic, take, duration })),
  clickLogStart: () => invoke<void>("click_log_start"),
  clickLogStop: () => invoke<{ clicks: ScreenClick[]; moves: ScreenClick[]; monitors: MonitorRect[] }>("click_log_stop"),
  freeSpace: () => invoke<number>("free_space"),

  rawStart: (kind: "mic" | "camera") => invoke<string>("raw_start", { kind }),
  rawAppend: (path: string, chunk: Uint8Array) => invoke<void>("raw_append", chunk, { headers: { "x-recording": path } }),
  rawDiscard: (path: string) => invoke<void>("raw_discard", { path }),
  cameraFinish: (raw: string, take: string, duration: number) => job((jobId) => invoke<string>("camera_finish", { jobId, raw, take, duration })),

  takeCreate: (name: string) => invoke<string>("take_create", { name }),
  takeSave: (take: string, data: TakeData) => invoke<void>("take_save", { take, json: JSON.stringify(data) }),
  takeGet: (take: string) => invoke<TakeInfo>("take_get", { take }),
  takeDelete: (take: string) => invoke<void>("take_delete", { take }),
  takeExport: (take: string, graph: string, camera: boolean, duration: number, fps: number) => job((jobId) => invoke<string>("take_export", { jobId, take, graph, camera, duration, fps })),
  library: () => invoke<TakeInfo[]>("library_list"),

  hud: {
    open: () => invoke<void>("hud_open"),
    close: () => invoke<void>("hud_close"),
    sendStatus: (s: HudStatus) => void emit("hud:status", s),
    onStatus: (cb: (s: HudStatus) => void) => listen<HudStatus>("hud:status", (e) => cb(e.payload)),
    sendCommand: (c: HudCommand) => void emit("hud:command", c),
    onCommand: (cb: (c: HudCommand) => void) => listen<HudCommand>("hud:command", (e) => cb(e.payload)),
  },
};
