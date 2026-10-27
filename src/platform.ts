// The only place that talks to the Rust side (Tauri commands and events). Screens use these
// functions; nothing else imports @tauri-apps.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { TakeEdit } from "./core/edits";
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
  /** The recording has sound (known when opened with takeGet). */
  audio?: boolean | null;
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
  /** The editor's cuts and per-zoom changes (absent until edited). */
  edit?: TakeEdit;
}

/** A screen area in physical pixels (what the countdown covers). */
export interface ScreenArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

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
    /** Calls back now and whenever the window is maximized or restored. */
    onMaximizedChange: async (cb: (maximized: boolean) => void) => {
      const w = getCurrentWindow();
      cb(await w.isMaximized());
      return w.onResized(() => void w.isMaximized().then(cb, () => undefined));
    },
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
  takeExport: (take: string, graph: string, camera: boolean, duration: number, fps: number, format: "mp4" | "gif", encoding: "fast" | "balanced" | "quality") =>
    job((jobId) => invoke<string>("take_export", { jobId, take, graph, camera, duration, fps, format, encoding })),
  library: () => invoke<TakeInfo[]>("library_list"),

  /** The floating capture bar (window "main"). */
  bar: {
    fit: (width: number, height: number) => invoke<void>("bar_fit", { width, height }),
    show: () => invoke<void>("bar_show"),
    /** Move the bar with the mouse (the OS drags the window from here). */
    drag: () => getCurrentWindow().startDragging(),
    onMoved: (cb: () => void) => getCurrentWindow().onMoved(() => cb()),
    onBlur: (cb: () => void) => getCurrentWindow().onFocusChanged((e) => void (e.payload || cb())),
  },
  quit: () => invoke<void>("app_quit"),

  /** Dark/light chosen in one window, applied in all of them. */
  theme: {
    send: (t: "dark" | "light") => void emit("theme:changed", t),
    onChange: (cb: (t: "dark" | "light") => void) => listen<"dark" | "light">("theme:changed", (e) => cb(e.payload)),
  },

  /** The click-through overlay over what is recorded: the frame, and the countdown before. */
  overlay: {
    /** Resolves true when Windows confirms the overlay is left out of the recording. */
    open: (area: ScreenArea) => invoke<boolean>("overlay_open", { ...area }),
    move: (area: ScreenArea) => invoke<void>("overlay_move", { ...area }),
    close: () => invoke<void>("overlay_close"),
    /** Resolves when the overlay has loaded (or after `wait` ms). */
    ready: (wait: number) =>
      new Promise<void>((resolve) => {
        const timer = window.setTimeout(done, wait);
        let off: (() => void) | null = null;
        void listen("overlay:ready", done).then((u) => (off = u));
        function done() {
          window.clearTimeout(timer);
          off?.();
          resolve();
        }
      }),
    sendReady: () => void emit("overlay:ready"),
    /** Seconds left in the countdown; 0 = recording. */
    tick: (n: number) => void emit("overlay:tick", n),
    onTick: (cb: (n: number) => void) => listen<number>("overlay:tick", (e) => cb(e.payload)),
    /** Draw the frame (sent only when the overlay is confirmed out of the recording). */
    frame: (on: boolean) => void emit("overlay:frame", on),
    onFrame: (cb: (on: boolean) => void) => listen<boolean>("overlay:frame", (e) => cb(e.payload)),
    paused: (on: boolean) => void emit("overlay:paused", on),
    onPaused: (cb: (on: boolean) => void) => listen<boolean>("overlay:paused", (e) => cb(e.payload)),
  },

  /** The editor window: a finished take, or the library. */
  editor: {
    open: (take: string | null) => invoke<void>("editor_open", { take }),
    firstTake: () => invoke<string | null>("editor_take"),
    minimize: () => invoke<void>("editor_minimize"),
    onOpen: (cb: (take: string | null) => void) => listen<string | null>("editor:open", (e) => cb(e.payload)),
  },
};
