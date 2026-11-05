// The only place that talks to the Rust side (Tauri commands and events). Screens use these
// functions; nothing else imports @tauri-apps.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { TakeEdit } from "./core/edits";
import type { MonitorRect, ScreenClick } from "./core/recorder";

export interface CaptureTargets {
  monitors: Array<{ index: number; name: string; x: number; y: number; width: number; height: number; primary: boolean }>;
  windows: Array<{ id: string; title: string }>;
}

/** What recording can do on this computer (Rust sys::PlatformInfo). */
export interface PlatformInfo {
  os: "windows" | "linux" | "macos";
  systemAudio: boolean;
  windowCapture: boolean;
  /** The capture bar and the frame are left out of recordings. */
  hidesFromCapture: boolean;
  /** Why recording cannot start here, if so. */
  blocked: string | null;
  /** A bold font file for text labels in exports, if one is found. */
  font?: string | null;
}

/** Part of a screen in physical pixels from the screen's corner (area recording). */
export interface AreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureSpec {
  kind: "monitor" | "window" | "area";
  monitor?: number;
  /** For "area": the part of `monitor` to record. */
  area?: AreaRect;
  window?: string;
  fps: number;
  cursor: boolean;
  systemAudio: boolean;
  /** "cpu" (x264) or a graphics card encoder. */
  encoder: Encoder;
  quality: Quality;
  /** Keep FFmpeg's messages as capture.log in the take. */
  keepLog: boolean;
}

/** A key that works from any app (hotkeys.rs); `ready` is false when another app owns it. */
export interface Hotkey {
  action: "record" | "pause" | "marker";
  keys: string;
  ready: boolean;
}

/** Where the capture bar sits: docked upright at a side of the screen, or lying along the bottom. */
export type Dock = "left" | "right" | "bottom";

/** "auto": the first graphics card encoder that works here, else the processor. */
export type Encoder = "auto" | "cpu" | "nvidia" | "intel" | "amd";
export type Quality = "standard" | "high" | "best";

/** capture_start: the recorded area, and how many seconds ago the picture started. */
export interface CaptureStarted {
  rect: MonitorRect;
  lead: number;
  /** The encoder actually recording (after "auto" and any fallback). */
  encoder: Exclude<Encoder, "auto">;
}

/**
 * Stop listening when an effect is cleaned up, also when the listener was still being set up
 * then (React runs effects twice in development; a late unlisten would leave the first one
 * listening, so one key press ran twice).
 */
export function listening(pending: Promise<() => void>): () => void {
  let done = false;
  let off: (() => void) | null = null;
  void pending.then((u) => (done ? u() : (off = u))).catch(() => undefined);
  return () => {
    done = true;
    off?.();
  };
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
  /** The library still (thumb.jpg), once made. */
  thumb?: string | null;
  /** Sounds kept on their own beside the recording (system.m4a, mic.m4a). */
  sounds?: Array<"system" | "mic">;
}

/** take.json: what the recorder knew (times are seconds of the recording). */
export interface TakeData {
  version: 1;
  createdAt: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** "import": a video opened from a file (no clicks or pointer path). */
  source: "monitor" | "window" | "area" | "import";
  /** "smooth": recorded without the cursor; the editor draws it from `path`. */
  cursor?: "smooth";
  clicks: Array<{ t: number; x: number; y: number }>;
  path: Array<{ t: number; x: number; y: number }>;
  markers: number[];
  zoom: { on: boolean; depth: number; hold: number; after: "follow" | "zoomOut" };
  ripples: boolean;
  camera: { spot: "bottom-right" | "bottom-left" | "top-right" | "top-left"; size: number } | null;
  /** The editor's cuts and per-zoom changes (absent until edited). */
  edit?: TakeEdit;
}

/** What an export reads besides the recording: the camera, the smooth cursor image, the separate
 *  sounds, and pictures or sounds by reference ("media:<name>", "builtin:<id>", "wallpaper:<name>"). */
export type ExportInput = "camera" | "cursor" | "system" | "mic" | `${"media" | "builtin" | "wallpaper"}:${string}`;

/** A picture or sound copied into a take (media.rs MediaFile). */
export interface MediaFile {
  reference: string;
  path: string;
  label: string;
  duration: number | null;
}

/** A video opened as a new take. */
export interface Imported {
  take: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
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
  /** Open a web page in the browser (help and feedback links). */
  openUrl: (url: string) => openUrl(url),
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

  info: () => invoke<PlatformInfo>("platform_info"),
  hotkeys: () => invoke<Hotkey[]>("hotkeys"),
  /** Change one shortcut key ("" = back to its default); resolves with all of them. */
  hotkeysSet: (action: Hotkey["action"], keys: string) => invoke<Hotkey[]>("hotkeys_set", { action, keys }),
  /** A shortcut key was pressed (in any app). */
  onHotkey: (cb: (action: Hotkey["action"]) => void) => listen<Hotkey["action"]>("hotkey", (e) => cb(e.payload)),
  captureTargets: () => invoke<CaptureTargets>("capture_targets"),
  captureStart: (spec: CaptureSpec) => invoke<CaptureStarted>("capture_start", { spec }),
  /** Graphics card encoders that work on this computer (empty: the CPU only). */
  captureEncoders: () => invoke<Encoder[]>("capture_encoders"),
  /** False when the screen capture ended on its own while recording. */
  captureAlive: () => invoke<boolean>("capture_alive"),
  capturePause: (paused: boolean) => invoke<void>("capture_pause", { paused }),
  captureCancel: () => invoke<void>("capture_cancel"),
  /** Makes recording.mp4; `duration` is the recorder's clock, the result has the video's real length. */
  captureFinish: (mic: string | null, micSkip: number, take: string, duration: number) =>
    job((jobId) => invoke<{ path: string; duration: number | null }>("capture_finish", { jobId, mic, micSkip, take, duration })),
  clickLogStart: () => invoke<void>("click_log_start"),
  clickLogStop: () => invoke<{ clicks: ScreenClick[]; moves: ScreenClick[]; monitors: MonitorRect[] }>("click_log_stop"),
  freeSpace: () => invoke<number>("free_space"),

  rawStart: (kind: "mic" | "camera") => invoke<string>("raw_start", { kind }),
  rawAppend: (path: string, chunk: Uint8Array) => invoke<void>("raw_append", chunk, { headers: { "x-recording": path } }),
  rawDiscard: (path: string) => invoke<void>("raw_discard", { path }),
  cameraFinish: (raw: string, skip: number, take: string, duration: number) => job((jobId) => invoke<string>("camera_finish", { jobId, raw, skip, take, duration })),

  takeCreate: (name: string) => invoke<string>("take_create", { name }),
  takeSave: (take: string, data: TakeData) => invoke<void>("take_save", { take, json: JSON.stringify(data) }),
  takeGet: (take: string) => invoke<TakeInfo>("take_get", { take }),
  takeDelete: (take: string) => invoke<void>("take_delete", { take }),
  /** `inputs`: the graph's inputs after the recording, in order (core/exportGraph.ts numbers them). */
  takeExport: (take: string, graph: string, inputs: ExportInput[], duration: number, fps: number, format: "mp4" | "gif", encoding: "fast" | "balanced" | "quality", gifLoop = true) =>
    job((jobId) => invoke<string>("take_export", { jobId, take, graph, inputs, duration, fps, format, encoding, gifLoop })),
  /** Still picture and silence at least `min` seconds long (core/quiet.ts keeps their overlap). */
  takeQuiet: (take: string, duration: number, min: number) => job((jobId) => invoke<{ freezes: Array<[number, number]>; silences: Array<[number, number]> | null }>("take_quiet", { jobId, take, duration, min })),
  library: () => invoke<TakeInfo[]>("library_list"),
  /** Make (or find) the take's library still; resolves with its path. */
  takeThumb: (take: string) => invoke<string>("take_thumb", { take }),
  /** Open a video file as a new take (null: the dialog was closed). */
  libraryImport: () => job((jobId) => invoke<Imported | null>("library_import", { jobId })),

  /** Pictures and sounds added to a take, and pictures the editor draws (media.rs). */
  media: {
    pick: (take: string, kind: "image" | "audio") => invoke<MediaFile | null>("media_pick", { take, kind }),
    /** Save a PNG into the take; resolves with its reference. */
    write: (take: string, name: string, png: Uint8Array) => invoke<string>("media_write", png, { headers: { "x-take": take, "x-name": name } }),
    wallpapers: () => invoke<string[]>("wallpapers_list"),
    wallpapersFolder: () => invoke<string>("wallpapers_folder"),
  },
  /** Upload or replace the take's camera footage (null: the dialog was closed), or remove it. */
  cameraImport: (take: string) => job((jobId) => invoke<string | null>("camera_import", { jobId, take })),
  cameraRemove: (take: string) => invoke<void>("camera_remove", { take }),
  /** Save the take's edit as a .capturely file, or open one (resolves with its take). */
  projectSave: (take: string) => invoke<string | null>("project_save", { take }),
  projectOpen: () => invoke<string | null>("project_open"),

  /** The floating capture bar (window "main"). */
  bar: {
    /** Size the window to the bar; `dock` keeps a docked side (and its middle) in place. */
    fit: (width: number, height: number, dock: Dock) => invoke<void>("bar_fit", { width, height, dock: dock === "bottom" ? null : dock }),
    /** After a move: docked at the left or right edge of the screen, or lying along the bottom. */
    dock: () => invoke<Dock>("bar_dock"),
    /** Resolves when the drag just started ends (the button let go), with where the bar docked. */
    dragEnd: () => invoke<Dock>("bar_drag_end"),
    show: () => invoke<void>("bar_show"),
    /** Hide to the tray: Capturely keeps running, so the shortcut keys still work. */
    hide: () => invoke<void>("bar_hide"),
    /** Move the bar with the mouse (the OS drags the window from here). */
    drag: () => getCurrentWindow().startDragging(),
    onBlur: (cb: () => void) => getCurrentWindow().onFocusChanged((e) => void (e.payload || cb())),
  },
  quit: () => invoke<void>("app_quit"),

  /** Dark/light chosen in one window, applied in all of them. */
  theme: {
    /** Tell the other windows. The event also comes back to this one, which has already changed
     *  (with its animation): it carries the sender, so the window that sent it skips it. */
    send: (t: "dark" | "light") => void emit("theme:changed", { theme: t, from: getCurrentWindow().label }),
    onChange: (cb: (t: "dark" | "light") => void) =>
      listen<{ theme: "dark" | "light"; from: string }>("theme:changed", (e) => {
        if (e.payload.from !== getCurrentWindow().label) cb(e.payload.theme);
      }),
  },

  /** The area picker over one screen (window "picker", ui/Picker.tsx). */
  picker: {
    /** Opens it over `screen` (physical pixels); resolves with the area dragged out, or null. */
    pick: async (screen: ScreenArea): Promise<AreaRect | null> => {
      let answer: (area: AreaRect | null) => void = () => undefined;
      const done = new Promise<AreaRect | null>((resolve) => (answer = resolve));
      const off = await listen<AreaRect | null>("picker:done", (e) => answer(e.payload));
      try {
        await invoke<void>("picker_open", { ...screen });
        return await done;
      } finally {
        off();
      }
    },
    done: (area: AreaRect | null) => void emit("picker:done", area),
    close: () => invoke<void>("picker_close"),
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
        const off = listening(listen("overlay:ready", done));
        function done() {
          window.clearTimeout(timer);
          off();
          resolve();
        }
      }),
    sendReady: () => void emit("overlay:ready"),
    onReady: (cb: () => void) => listen("overlay:ready", () => cb()),
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
