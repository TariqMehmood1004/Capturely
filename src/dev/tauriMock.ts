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
  clicks: clicks.filter((c) => c.t < duration),
  path: [],
  markers: [5, 18].filter((m) => m < duration),
  zoom: { on: true, depth: 1.8, hold: 1.5, after: "follow" },
  ripples: true,
  camera: null,
});
const takes: TakeInfo[] = [
  ["Recording 2026-10-28 10.25.33", 31, 48],
  ["Product walkthrough", 94, 132],
  ["Bug report: export dialog", 12, 9],
  ["Onboarding flow", 245, 310],
  ["Release notes demo", 58, 71],
].map(([name, d, mb], i) => ({
  path: `C:/Users/demo/Videos/ReeliF Capture/${name}`,
  name: name as string,
  data: data(d as number),
  video: "/node_modules/.preview/sample.mp4",
  camera: null,
  exports: i === 1 ? ["Export.mp4"] : [],
  bytes: (mb as number) * 1e6,
  modified: Date.now() - i * 86_400_000,
  audio: true,
}));

const replies: Record<string, (args: Record<string, unknown>) => unknown> = {
  platform_info: () => ({ os: "windows", systemAudio: true, windowCapture: true, hidesFromCapture: true, blocked: null }),
  capture_targets: () => ({
    monitors: [
      { index: 0, name: "Screen 1", x: 0, y: 0, width: 1920, height: 1080, primary: true },
      { index: 1, name: "Screen 2", x: 1920, y: 0, width: 2560, height: 1440, primary: false },
    ],
    windows: [
      { id: "1", title: "ReeliF Capture - Visual Studio Code" },
      { id: "2", title: "Swagger UI - Google Chrome" },
      { id: "3", title: "Calculator" },
    ],
  }),
  capture_encoders: () => ["intel"],
  free_space: () => 120e9,
  library_list: () => takes,
  take_get: (a) => takes.find((t) => t.path === a.take || t.name === a.take) ?? takes[0],
  editor_take: () => params.get("take"),
  "plugin:window|is_maximized": () => true,
  "plugin:event|listen": () => ++ids,
};
let ids = 0;

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
if (label !== "editor") document.body.style.background = "#5b6475";
