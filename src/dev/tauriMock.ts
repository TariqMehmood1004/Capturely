// Development only: a stand-in for Tauri so the windows can be seen in a normal browser while
// working on the design (`npm run dev`, then http://localhost:1430/?w=editor | main | overlay).
// Sample takes play `node_modules/.preview/sample.mp4` when that file exists. Never bundled into
// the app: main.tsx imports it only in development and outside Tauri.
import type { TakeData, TakeInfo } from "../platform";

const params = new URLSearchParams(location.search);
const label = params.get("w") ?? "editor";

const clicks = [2, 4.5, 7, 11, 15.5, 21, 26].map((t, i) => ({ t, x: 0.2 + ((i * 0.13) % 0.6), y: 0.25 + ((i * 0.17) % 0.5) }));
const data = (duration: number): TakeData => ({
  version: 1,
  createdAt: new Date().toISOString(),
  duration,
  width: 1920,
  height: 1080,
  fps: 30,
  source: "monitor",
  cursor: "smooth",
  clicks: clicks.filter((c) => c.t < duration),
  // A pointer path that wanders (the smooth cursor draws it).
  path: Array.from({ length: 40 }, (_, i) => ({ t: i * 0.05 + (i > 20 ? 0.8 : 0), x: 0.3 + 0.3 * Math.sin(i / 6), y: 0.4 + 0.2 * Math.cos(i / 5) })).filter((p) => p.t < duration),
  markers: [5, 18].filter((m) => m < duration),
  zoom: { on: true, depth: 1.8, hold: 1.5, after: "follow" },
  ripples: true,
  camera: null,
});
const takes: TakeInfo[] = params.get("empty") ? [] : [
  ["Recording 2026-10-28 10.25.33", 31, 48],
  ["Product walkthrough", 94, 132],
  ["Bug report: export dialog", 12, 9],
  ["Onboarding flow", 245, 310],
  ["Release notes demo", 58, 71],
].map(([name, d, mb], i) => ({
  path: `C:/Users/demo/Videos/Capturely/${name}`,
  name: name as string,
  data: data(d as number),
  video: "/node_modules/.preview/sample.mp4",
  camera: null,
  exports: i === 1 ? ["Export.mp4"] : [],
  bytes: (mb as number) * 1e6,
  modified: Date.now() - i * 86_400_000,
  audio: true,
  sounds: [],
}));

let stopExport = () => undefined as void;
const replies: Record<string, (args: Record<string, unknown>) => unknown> = {
  platform_info: () => ({ os: "windows", systemAudio: true, windowCapture: true, hidesFromCapture: true, blocked: null, font: "C:/Windows/Fonts/segoeuib.ttf" }),
  capture_targets: () => ({
    monitors: [
      { index: 0, name: "Screen 1", x: 0, y: 0, width: 1920, height: 1080, primary: true },
      { index: 1, name: "Screen 2", x: 1920, y: 0, width: 2560, height: 1440, primary: false },
    ],
    windows: [
      { id: "1", title: "Capturely - Visual Studio Code" },
      { id: "2", title: "Swagger UI - Google Chrome" },
      { id: "3", title: "Calculator" },
    ],
  }),
  capture_encoders: () => ["intel"],
  hotkeys: () => [
    { action: "record", keys: "Alt+Shift+R", ready: true },
    { action: "pause", keys: "Alt+Shift+P", ready: true },
    { action: "marker", keys: "Alt+Shift+M", ready: true },
  ],
  free_space: () => 120e9,
  library_list: () => takes,
  take_quiet: () => ({ freezes: [[2.1, 3.1]], silences: null }),
  // An export runs until it is stopped (to work on the export button and its Stop).
  take_export: () => new Promise((_, reject) => (stopExport = () => reject({ code: "cancelled", message: "The operation was cancelled." }))),
  cancel_job: () => (stopExport(), true),
  take_get: (a) => takes.find((t) => t.path === a.take || t.name === a.take) ?? takes[0],
  editor_take: () => params.get("take"),
  capture_alive: () => true,
  // Recording in the browser preview: the bar goes through its countdown and recording states.
  capture_start: () => ({ rect: { x: 0, y: 0, width: 1920, height: 1080 }, lead: 0, encoder: "intel" }),
  take_create: () => "C:/Users/demo/Videos/Capturely/Preview take",
  // The bar's side: ?dock=left or right to see it standing at a side.
  bar_dock: () => params.get("dock") ?? "bottom",
  bar_drag_end: () => params.get("dock") ?? "bottom",
  take_thumb: () => Promise.reject(new Error("no stills in the browser preview")),
  hotkeys_set: (a) => [
    { action: "record", keys: a.action === "record" ? a.keys || "Alt+Shift+R" : "Alt+Shift+R", ready: true },
    { action: "pause", keys: a.action === "pause" ? a.keys || "Alt+Shift+P" : "Alt+Shift+P", ready: true },
    { action: "marker", keys: a.action === "marker" ? a.keys || "Alt+Shift+M" : "Alt+Shift+M", ready: true },
  ],
  wallpapers_list: () => [],
  wallpapers_folder: () => "C:/Users/demo/Videos/Capturely/Wallpapers",
  media_write: (a) => `media:${String((a as { name?: string }).name ?? "shape.png")}`,
  // The dialogs: a picture (the app's logo) or a sound is "picked".
  media_pick: (a) => (a.kind === "image" ? { reference: "media:logo.png", path: "/src/assets/capturely-logo.png", label: "logo.png", duration: null } : { reference: "media:music.mp3", path: "/none.mp3", label: "music.mp3", duration: 12 }),
  project_save: () => "C:/Users/demo/Documents/Recording.capturely",
  project_open: () => takes[1]!.path,
  "plugin:window|is_maximized": () => true,
  // Events: listeners are kept by name; `emit` (and window.__emit in the console, e.g.
  // __emit("overlay:tick", 3) on ?w=overlay) calls them, as Tauri would.
  "plugin:event|listen": (a) => {
    const name = String(a.event);
    (listeners[name] ??= []).push(Number(a.handler));
    return ++ids;
  },
  "plugin:event|emit": (a) => void emitLocal(String(a.event), a.payload),
};
let ids = 0;
const listeners: Record<string, number[]> = {};
function emitLocal(event: string, payload: unknown) {
  for (const h of listeners[event] ?? []) (w[`_${h}`] as ((e: unknown) => void) | undefined)?.({ event, id: h, payload });
}

const w = window as unknown as Record<string, unknown>;
w.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label }, currentWebview: { windowLabel: label, label } },
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => replies[cmd]?.(args) ?? null,
  transformCallback: (cb: unknown) => {
    const id = ++ids;
    w[`_${id}`] = cb;
    return id;
  },
  unregisterCallback: () => undefined,
  convertFileSrc: (path: string) => path,
};
w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
w.__emit = emitLocal;
if (label !== "editor") document.body.style.background = "#5b6475";
