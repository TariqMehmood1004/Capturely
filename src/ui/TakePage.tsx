import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import cursorImg from "../assets/cursor.png";
import { blurAt, cursorImageShare, cursorPoses, cursorTrack, poseAt } from "../core/cursor";
import { RING_TIME } from "../core/exportGraph";
import { PLAIN_FRAME, frameCss } from "../core/frame";
import { fitMark, imageBox, newMark, shapeSvg, SHAPE_COLORS, SHAPES, type Mark } from "../core/marks";
import { quietSpans } from "../core/quiet";
import { camReact, cameraBox, cropPoint, DEFAULT_STYLE, layout, type CameraLook, type EditorStyle } from "../core/style";
import { isPlain, outDuration, rateAt, RATES, segments, SPEEDS } from "../core/timeline";
import { clickRegions, fitManualZoom, manualRegion, newManualZoom, pointerZooms, regionKeys, suggestZooms, viewAt, withManual, zoomView, type ManualZoom } from "../core/zoom";
import { errorMessage, platform, type Hotkey, type PlatformInfo, type TakeData, type TakeInfo } from "../platform";
import { addSpeeds, addSplit, editedZooms, editZoom, EMPTY_EDIT, isCut, mergeSpans, pieces, playFrom, removeSpeeds, togglePiece, validEdit, type AudioClip, type Span, type TakeEdit } from "../core/edits";
import { DEFAULT_EXPORT, ENCODINGS, exportScale, FPS_CHOICES, GIF_WIDTHS, QUALITIES, qualityScale, savePreset, validExport, validPreset, type EditorPreset, type ExportSettings } from "../core/exportSettings";
import { CameraPanel } from "./CameraPanel";
import { Dropdown, Segmented, Slider, Switch } from "./controls";
import { planExport } from "./exportRun";
import { FramePanel } from "./FramePanel";
import { refUrl } from "./media";
import { MOTION, reducedMotion } from "./motion";
import { BoltIcon, ChatBubbleBottomCenterTextIcon, ChatBubbleLeftRightIcon, ClockIcon, DocumentArrowDownIcon, EyeSlashIcon, MusicalNoteIcon, PaintBrushIcon, PlusIcon, QuestionMarkCircleIcon, SparklesIcon, SpeakerWaveIcon, ViewfinderCircleIcon } from "./icons";
import { ArrowDownTrayIcon, ArrowUturnLeftIcon, ArrowUturnRightIcon, BackwardIcon, BookmarkIcon, ChevronDownIcon, CursorArrowRaysIcon, FilmIcon, FlagIcon, FolderOpenIcon, ForwardIcon, InformationCircleIcon, ListBulletIcon, MagnifyingGlassPlusIcon, PauseIcon, PhotoIcon, PlayIcon, ScissorsIcon, StopIcon, TrashIcon, VideoCameraIcon } from "./icons";
import { formatTime } from "./motion";

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** Time with tenths, for the timecode and the lists. */
const stamp = (t: number) => `${formatTime(t)}.${Math.floor((Math.max(0, t) % 1) * 10)}`;
const bytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
const rateLabel = (r: number) => `${r}×`;
type Tool = "zoom" | "clicks" | "sound" | "frame" | "camera";
type Pane = "details" | "clicks" | "markers" | "quiet" | "speed" | "marks";
type Sel = { kind: "piece" | "zoom"; i: number } | { kind: "manual" | "audio"; id: string } | null;
const inMark = (m: Mark, t: number) => t >= m.a && t < m.b;
/** Where to report problems and ideas (opens in the browser). */
const FEEDBACK_URL = "https://github.com/TariqMehmood1004/Capturely/issues";

/** Side panel, inspector and timeline sizes in px (the splitters change them). */
interface Sizes {
  lib: number;
  insp: number;
  tl: number;
}
const SIZES_KEY = "reelifcapture.editorSizes";
const EXPORT_KEY = "reelifcapture.export";
const PRESETS_KEY = "reelifcapture.presets";
function load<T>(key: string, read: (v: unknown) => T, fallback: T): T {
  try {
    return read(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    return fallback;
  }
}
function store(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* not remembered */
  }
}
const readPresets = (v: unknown): EditorPreset[] => (Array.isArray(v) ? v.map(validPreset).filter((x): x is EditorPreset => !!x) : []);
const DEFAULT_SIZES: Sizes = { lib: 260, insp: 320, tl: 196 };
const LIMITS: Record<keyof Sizes, [number, number]> = { lib: [200, 420], insp: [280, 460], tl: [150, 360] };
function loadSizes(): Sizes {
  try {
    const s = { ...DEFAULT_SIZES, ...(JSON.parse(localStorage.getItem(SIZES_KEY) ?? "{}") as Partial<Sizes>) };
    return { lib: Math.min(LIMITS.lib[1], Math.max(LIMITS.lib[0], s.lib)), insp: Math.min(LIMITS.insp[1], Math.max(LIMITS.insp[0], s.insp)), tl: Math.min(LIMITS.tl[1], Math.max(LIMITS.tl[0], s.tl)) };
  } catch {
    return DEFAULT_SIZES;
  }
}

/** The look of a take never edited: what was chosen in the capture bar before recording. */
function recordedStyle(d: TakeData): EditorStyle {
  return { ...DEFAULT_STYLE, zoom: { ...d.zoom }, rings: d.ripples, camera: d.camera ? { ...DEFAULT_STYLE.camera, spot: d.camera.spot, size: d.camera.size } : DEFAULT_STYLE.camera };
}

/** The editor's keys, for the shortcut list. */
const EDITOR_KEYS: ReadonlyArray<[string, string]> = [
  ["Space", "Play or pause"],
  ["← →", "Back or on one second"],
  ["Home / End", "Go to the start or the end"],
  ["S", "Split the clip at the playhead"],
  ["Delete", "Remove the selected piece, zoom, mark or sound"],
  ["Esc", "Clear the selection"],
  ["Ctrl+Z", "Undo"],
  ["Ctrl+Y / Ctrl+Shift+Z", "Redo"],
];
const HOTKEY_LABEL: Record<Hotkey["action"], string> = { record: "Start or stop recording", pause: "Pause or resume", marker: "Add a marker" };

/**
 * The editor for a finished recording, laid out like ReeliF Studio: a rail and side panel
 * (details, clicks, markers, quiet parts, speed, marks), the player (tools, stage, transport), the
 * inspector with tabs, and the timeline across the bottom. Panels are separated by resizable
 * splitters. Everything changed here is the take's edit (take.json), saved as it changes.
 */
export function TakePage({ take, onDeleted }: { take: string; onDeleted: () => void }) {
  const [info, setInfo] = useState<TakeInfo | null>(null);
  // The panels rise in one after another when the take opens.
  const shell = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    const el = shell.current;
    if (!el || !info || shown.current) return;
    shown.current = true;
    if (reducedMotion()) return;
    const panels = el.querySelectorAll(":scope > :not(.ed-split)");
    gsap.fromTo(panels, { y: MOTION.rise, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: MOTION.base, ease: MOTION.ease, stagger: 0.05, clearProps: "transform,opacity,visibility" });
  }, [info]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [exporting, setExporting] = useState<number | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  /** Stops the running export (FFmpeg is ended and its partial file removed). */
  const stopExport = useRef<(() => Promise<void>) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const cam = useRef<HTMLVideoElement | null>(null);
  const camBox = useRef<HTMLSpanElement | null>(null);
  const zoomEl = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<Tool>("zoom");
  // The edit, with undo; saved into take.json shortly after each change.
  const [edit, setEditState] = useState<TakeEdit>(EMPTY_EDIT);
  const [sel, setSel] = useState<Sel>(null);
  const editRef = useRef(edit);
  editRef.current = edit;
  const history = useRef<{ back: TakeEdit[]; fwd: TakeEdit[]; key: string; at: number }>({ back: [], fwd: [], key: "", at: 0 });
  const dirty = useRef(false);
  /** Change the edit; quick repeats of one control (`key`, e.g. a slider drag) are one undo step. */
  const setEdit = (next: TakeEdit, key = "") => {
    const h = history.current;
    const now = performance.now();
    if (!(key && key === h.key && now - h.at < 700)) h.back = [...h.back, editRef.current].slice(-60);
    h.fwd = [];
    h.key = key;
    h.at = now;
    dirty.current = true;
    setEditState(next);
  };
  const undo = () => {
    const h = history.current;
    const prev = h.back.pop();
    if (!prev) return;
    h.fwd.push(editRef.current);
    h.key = "";
    dirty.current = true;
    setEditState(prev);
  };
  const redo = () => {
    const h = history.current;
    const next = h.fwd.pop();
    if (!next) return;
    h.back.push(editRef.current);
    h.key = "";
    dirty.current = true;
    setEditState(next);
  };
  const style = edit.style;
  const setStyle = (patch: Partial<EditorStyle>, key = "") => setEdit({ ...editRef.current, style: { ...editRef.current.style, ...patch } }, key);
  const setZoom = (patch: Partial<EditorStyle["zoom"]>, key = "") => setStyle({ zoom: { ...editRef.current.style.zoom, ...patch } }, key);
  const setCamera = (patch: Partial<CameraLook>, key = "") => setStyle({ camera: { ...editRef.current.style.camera, ...patch } }, key);
  // Export choices and saved looks, remembered on this computer.
  const [exp, setExp] = useState<ExportSettings>(() => load(EXPORT_KEY, validExport, DEFAULT_EXPORT));
  const [presets, setPresets] = useState<EditorPreset[]>(() => load(PRESETS_KEY, readPresets, []));
  const [presetName, setPresetName] = useState("");
  useEffect(() => store(EXPORT_KEY, exp), [exp]);
  useEffect(() => store(PRESETS_KEY, presets), [presets]);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  // The font for text labels (and what else this system offers), the shortcut keys, wallpapers.
  const [caps, setCaps] = useState<PlatformInfo | null>(null);
  const [hotkeys, setHotkeys] = useState<Hotkey[]>([]);
  const [wallpapers, setWallpapers] = useState<string[]>([]);
  const [wallDir, setWallDir] = useState<string | null>(null);
  useEffect(() => {
    void platform.info().then(setCaps, () => undefined);
    void platform.hotkeys().then(setHotkeys, () => undefined);
    void platform.media.wallpapersFolder().then(setWallDir, () => undefined);
    void platform.media.wallpapers().then(setWallpapers, () => undefined);
  }, []);
  const [selMark, setSelMark] = useState<string | null>(null);
  // Quiet parts found (null: not looked for yet), the search's progress, and the choices.
  const [quiet, setQuiet] = useState<Span[] | null>(null);
  const [finding, setFinding] = useState<number | null>(null);
  const [quietMin, setQuietMin] = useState(2);
  const [quietRate, setQuietRate] = useState<number>(4);
  const [speedRate, setSpeedRate] = useState<number>(2);
  /** A zoom placed by hand waiting for its spot to be clicked on the picture. */
  const [pickSpot, setPickSpot] = useState<string | null>(null);
  const [camImport, setCamImport] = useState<number | null>(null);
  const cursorEl = useRef<HTMLImageElement | null>(null);
  const sysAudio = useRef<HTMLAudioElement | null>(null);
  const micAudio = useRef<HTMLAudioElement | null>(null);
  const clipEls = useRef(new Map<string, HTMLAudioElement>());
  const canvas = useRef<HTMLDivElement | null>(null);
  const lanes = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);

  const reload = () =>
    platform
      .takeGet(take)
      .then((t) => {
        setInfo(t);
        return t;
      })
      .catch((e: unknown) => {
        setError(errorMessage(e));
        return null;
      });
  useEffect(() => {
    void reload().then((t) => t?.data && setEditState(validEdit(t.data.edit, recordedStyle(t.data))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take]);

  const data = info?.data ?? null;
  // The video's own length, once known: older takes saved a clock time a little past the picture.
  const [videoLen, setVideoLen] = useState<number | null>(null);
  const duration = videoLen && data ? Math.min(data.duration, videoLen) : (data?.duration ?? 0);
  // Clicks and the pointer path on the (cropped) picture.
  const crop = style.crop;
  const clicks = useMemo(() => (data?.clicks ?? []).map((c) => cropPoint(c, crop)), [data, crop]);
  const path = useMemo(() => (data?.path ?? []).map((p) => cropPoint(p, crop)), [data, crop]);
  const zl = style.zoom;
  // Click zooms from the recording, then the changes made to single zooms, then zooms by hand.
  const regions = useMemo(() => {
    if (!clicks.length) return [];
    const opts = { zoom: zl.depth, hold: zl.hold, after: zl.after };
    return path.length ? pointerZooms(clicks, path, duration, opts) : clickRegions(clicks, duration, opts);
  }, [clicks, path, zl.depth, zl.hold, zl.after, duration]);
  const zoomList = useMemo(() => editedZooms(regions, edit.zooms), [regions, edit.zooms]);
  const manual = edit.added;
  const coveredByHand = (r: { start: number; end: number }) => manual.some((m) => m.a < r.end && m.b > r.start);
  const keys = useMemo(() => regionKeys(withManual(zl.on ? zoomList.filter((r) => !r.off) : [], manual)), [zl.on, zoomList, manual]);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const cutsRef = useRef(edit.cuts);
  cutsRef.current = edit.cuts;
  // The output's clock: cuts and speed changes (core/timeline.ts).
  const segs = useMemo(() => segments(duration, edit.cuts, edit.speeds), [duration, edit.cuts, edit.speeds]);
  const segsRef = useRef(segs);
  segsRef.current = segs;
  const kept = outDuration(segs);
  // The smooth cursor (takes recorded with it), drawn from the pointer path with its effects.
  const smooth = data?.cursor === "smooth" && path.length > 0;
  const look = edit.cursor;
  const track = useMemo(() => (smooth ? cursorTrack(path, duration, look.smooth, look.loop) : []), [smooth, path, duration, look.smooth, look.loop]);
  const poses = useMemo(() => cursorPoses(track, look, clicks.map((c) => c.t)), [track, look, clicks]);
  const live = useRef({ poses, look, camera: style.camera, audio: edit.audio, playing });
  live.current = { poses, look, camera: style.camera, audio: edit.audio, playing };
  const sounds = info?.sounds ?? [];
  const sep = info?.path.includes("\\") ? "\\" : "/";
  const url = (ref: string) => (info ? refUrl(ref, info.path, wallDir) : "");

  // Saved into take.json a moment after the last change.
  useEffect(() => {
    if (!dirty.current || !info?.data) return;
    const d = info.data;
    const id = window.setTimeout(() => {
      dirty.current = false;
      void platform.takeSave(take, { ...d, edit }).catch((e: unknown) => setError(`The edit could not be saved: ${errorMessage(e)}`));
    }, 400);
    return () => window.clearTimeout(id);
  }, [edit, info, take]);

  // The preview follows the video frame by frame (the same curves as the export). The picture,
  // cursor and bubble move directly every frame; the page itself (timecode, playhead, marks) is
  // drawn again at most 15 times a second while playing, and not at all while nothing changes,
  // so an open editor costs next to nothing on slower computers.
  useEffect(() => {
    let raf = 0;
    let seen: { t: number; paused: boolean; keys: unknown; live: unknown } | null = null;
    let shownAt = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        let t = v.currentTime;
        // Playback jumps over the cuts (and stops at one that runs to the end).
        if (!v.paused) {
          const next = playFrom(t, duration, cutsRef.current);
          if (next === null) {
            v.pause();
            cam.current?.pause();
            setPlaying(false);
          } else if (next !== t) {
            v.currentTime = next;
            t = next;
          }
        }
        const L = live.current;
        if (seen && seen.t === t && seen.paused === v.paused && seen.keys === keysRef.current && seen.live === L) {
          raf = requestAnimationFrame(tick);
          return;
        }
        seen = { t, paused: v.paused, keys: keysRef.current, live: L };
        const ms = performance.now();
        if (v.paused || ms - shownAt > 66) {
          setTime(t);
          shownAt = ms;
        }
        // Faster and slower stretches (the separate sounds too); the cursor follows its poses.
        const rate = rateAt(segsRef.current, t) || 1;
        if (v.playbackRate !== rate) v.playbackRate = rate;
        const p = poseAt(L.poses, t);
        const ce = cursorEl.current;
        if (p && ce) {
          ce.style.left = `${p.x * 100}%`;
          ce.style.top = `${p.y * 100}%`;
          ce.style.transform = p.s !== 1 || p.a !== 0 ? `scale(${p.s.toFixed(3)}) rotate(${p.a.toFixed(4)}rad)` : "";
          const b = blurAt(L.poses, t, L.look.blur, ce.parentElement?.clientHeight ?? 0);
          ce.style.filter = b > 0.3 ? `blur(${b.toFixed(1)}px)` : "";
        }
        for (const a of [sysAudio.current, micAudio.current]) {
          if (!a) continue;
          if (Math.abs(a.currentTime - t) > 0.2) a.currentTime = t;
          if (a.playbackRate !== rate) a.playbackRate = rate;
          if (v.paused && !a.paused) a.pause();
          else if (!v.paused && a.paused) void a.play().catch(() => undefined);
        }
        // Extra sound plays where it was placed.
        for (const c of L.audio) {
          const el = clipEls.current.get(c.id);
          if (!el) continue;
          const inside = t >= c.a && t < c.a + c.len;
          const want = c.from + (t - c.a);
          if (inside && Math.abs(el.currentTime - want) > 0.25) el.currentTime = want;
          if (el.playbackRate !== rate) el.playbackRate = rate;
          if ((!inside || v.paused) && !el.paused) el.pause();
          else if (inside && !v.paused && el.paused) void el.play().catch(() => undefined);
        }
        const z = viewAt(keysRef.current, t);
        if (zoomEl.current) zoomEl.current.style.transform = `scale(${z.z}) translate(${-zoomView(z.fx, z.z) * 100}%, ${-zoomView(z.fy, z.z) * 100}%)`;
        if (camBox.current) camBox.current.style.transform = L.camera.zoomReact ? `scale(${camReact(z.z).toFixed(4)})` : "";
        const c = cam.current;
        if (c && Math.abs(c.currentTime - t) > 0.15) c.currentTime = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration]);

  useEffect(() => {
    const v = video.current;
    const s = edit.sound;
    if (v) {
      v.muted = sounds.length > 0;
      v.volume = Math.min(1, s.system);
    }
    if (sysAudio.current) sysAudio.current.volume = Math.min(1, s.system);
    if (micAudio.current) micAudio.current.volume = Math.min(1, s.mic);
    for (const c of edit.audio) {
      const el = clipEls.current.get(c.id);
      if (el) el.volume = Math.min(1, c.volume);
    }
  }, [edit.sound, edit.audio, sounds.length, info]);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (isCut(cutsRef.current, v.currentTime)) v.currentTime = playFrom(v.currentTime, duration, cutsRef.current) ?? 0;
      void v.play();
      void cam.current?.play().catch(() => undefined);
      setPlaying(true);
    } else {
      v.pause();
      cam.current?.pause();
      setPlaying(false);
    }
  };

  const ringNow = useMemo(() => {
    if (!style.rings) return [];
    return clicks
      .filter((c) => time >= c.t && time < c.t + RING_TIME)
      .map((c) => {
        const v = viewAt(keys, c.t);
        return { x: (c.x - zoomView(v.fx, v.z)) * v.z, y: (c.y - zoomView(v.fy, v.z)) * v.z, k: c.t };
      });
  }, [style.rings, clicks, time, keys]);

  const currentLook = (name: string): EditorPreset => {
    const { crop: _crop, ...rest } = style;
    return { name, style: rest, cursor: look, export: exp };
  };
  const applyLook = (p: EditorPreset) => {
    setEdit({ ...editRef.current, style: { ...p.style, crop: editRef.current.style.crop }, cursor: p.cursor });
    setExp(p.export);
  };
  const saveLook = () => {
    const name = presetName.trim();
    if (!name) return;
    setPresets((list) => savePreset(list, currentLook(name)));
    setPresetName("");
  };

  const doExport = async () => {
    if (!data || !info) return;
    setError(null);
    setNote(null);
    setExported(null);
    setExporting(0);
    try {
      const plan = await planExport({ take, info, data, edit, exp, keys, clicks, poses: smooth ? poses : null, segs, font: caps?.font ?? null });
      const job = platform.takeExport(take, plan.graph, plan.inputs, kept, plan.fps, exp.format, exp.encoding, exp.gifLoop);
      stopExport.current = job.cancel;
      const off = await job.onProgress((p) => p >= 0 && setExporting(p));
      const out = await job.promise.finally(off);
      setExported(out);
      await reload();
    } catch (e) {
      // Stopped on purpose: nothing went wrong, so nothing to report.
      if (!(typeof e === "object" && e && "code" in e && e.code === "cancelled")) setError(`The export failed: ${errorMessage(e)}`);
    } finally {
      stopExport.current = null;
      setExporting(null);
    }
  };

  const saveProject = async () => {
    setError(null);
    try {
      // The latest change first, so the project has it.
      if (info?.data) await platform.takeSave(take, { ...info.data, edit: editRef.current });
      dirty.current = false;
      const where = await platform.projectSave(take);
      if (where) setNote(`Project saved: ${where.split(/[\\/]/).pop()}`);
    } catch (e) {
      setError(`The project could not be saved: ${errorMessage(e)}`);
    }
  };

  /** Look for quiet parts (FFmpeg), then keep what is also free of pointer moves. */
  const findQuiet = async () => {
    setError(null);
    setFinding(0);
    try {
      const job = platform.takeQuiet(take, duration, quietMin);
      const off = await job.onProgress((p) => p >= 0 && setFinding(p));
      const r = await job.promise.finally(off);
      const spans = (l: Array<[number, number]>) => l.map(([a, b]) => ({ a, b }));
      setQuiet(quietSpans(spans(r.freezes), r.silences ? spans(r.silences) : null, (data?.path ?? []).map((x) => x.t), quietMin));
    } catch (e) {
      setError(`Quiet parts could not be found: ${errorMessage(e)}`);
    } finally {
      setFinding(null);
    }
  };

  const addMark = (kind: Mark["kind"], extra: Partial<Mark> = {}) => {
    const m = newMark(kind, time, duration, 3, extra);
    setEdit({ ...editRef.current, marks: [...editRef.current.marks, m] });
    setSelMark(m.id);
    setPane("marks");
  };
  const addPicture = async () => {
    setError(null);
    try {
      const f = await platform.media.pick(take, "image");
      if (!f) return;
      // The picture keeps its own shape (as a share of the video's height and width).
      const img = new Image();
      img.src = platform.mediaUrl(f.path);
      await img.decode().catch(() => undefined);
      const ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      const out = layout({ width: data?.width ?? 16, height: data?.height ?? 9 }, style).out;
      const h = 0.3;
      addMark("image", { file: f.reference, w: Math.min(0.9, (h * ar * out.height) / out.width), h });
      await reload();
    } catch (e) {
      setError(`The picture could not be added: ${errorMessage(e)}`);
    }
  };
  const changeMark = (id: string, patch: Partial<Mark>, key = "") => setEdit({ ...editRef.current, marks: editRef.current.marks.map((m) => (m.id === id ? fitMark({ ...m, ...patch }, duration) : m)) }, key);
  const deleteMark = (id: string) => {
    setEdit({ ...editRef.current, marks: editRef.current.marks.filter((m) => m.id !== id) });
    setSelMark(null);
  };
  /** Drag a mark on the picture: move it, or (`size`) resize it from its corner (an arrow's end). */
  const dragMark = (m: Mark, mode: "move" | "size") => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelMark(m.id);
    setPane("marks");
    const host = e.currentTarget.closest(m.kind === "blur" ? ".take-zoom" : ".take-stage");
    if (!host) return;
    const r = host.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / r.width;
      const dy = (ev.clientY - y0) / r.height;
      changeMark(m.id, mode === "move" ? { x: m.x + dx, y: m.y + dy } : { w: m.w + dx, h: m.h + dy }, `mark-${m.id}`);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Zooms placed by hand.
  const changeManual = (id: string, patch: Partial<ManualZoom>, key = "") => setEdit({ ...editRef.current, added: editRef.current.added.map((m) => (m.id === id ? fitManualZoom({ ...m, ...patch }, duration) : m)) }, key);
  const addManual = () => {
    const p = poseAt(poses, time);
    const m = newManualZoom(time, duration, p ? { x: p.x, y: p.y } : undefined, zl.depth);
    setEdit({ ...editRef.current, added: [...editRef.current.added, m] });
    setSel({ kind: "manual", id: m.id });
    setTool("zoom");
  };
  const suggest = () => {
    const found = suggestZooms(path, duration, withManual(zl.on ? zoomList.filter((r) => !r.off) : [], manual), { zoom: zl.depth });
    if (!found.length) return setNote("No new spots found: the pointer does not rest anywhere a zoom is not already.");
    setEdit({ ...editRef.current, added: [...editRef.current.added, ...found] });
    setNote(`${found.length} zoom${found.length === 1 ? "" : "s"} added where the pointer rests.`);
  };
  /** A click on the picture while a zoom waits for its spot: the spot under the click. */
  const pickOnPicture = (e: ReactPointerEvent<HTMLElement>) => {
    if (!pickSpot) return;
    e.stopPropagation();
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const v = viewAt(keys, time);
    const x = zoomView(v.fx, v.z) + (e.clientX - r.left) / r.width / v.z;
    const y = zoomView(v.fy, v.z) + (e.clientY - r.top) / r.height / v.z;
    changeManual(pickSpot, { x, y });
    setPickSpot(null);
  };

  // Extra sound.
  const addSound = async () => {
    setError(null);
    try {
      const f = await platform.media.pick(take, "audio");
      if (!f) return;
      const clip: AudioClip = { id: `audio-${Date.now().toString(36)}`, file: f.reference, name: f.label, a: Math.min(time, Math.max(0, duration - 0.5)), len: Math.max(0.1, Math.min(f.duration ?? duration, duration)), from: 0, volume: 1 };
      setEdit({ ...editRef.current, audio: [...editRef.current.audio, clip] });
      setSel({ kind: "audio", id: clip.id });
      setTool("sound");
      await reload();
    } catch (e) {
      setError(`The sound could not be added: ${errorMessage(e)}`);
    }
  };
  const changeClip = (id: string, patch: Partial<AudioClip>, key = "") => setEdit({ ...editRef.current, audio: editRef.current.audio.map((c) => (c.id === id ? { ...c, ...patch } : c)) }, key);
  const deleteClip = (id: string) => {
    setEdit({ ...editRef.current, audio: editRef.current.audio.filter((c) => c.id !== id) });
    setSel(null);
  };

  // Speed regions.
  const changeSpeed = (i: number, patch: Partial<{ a: number; b: number; rate: number }>) => {
    const list = editRef.current.speeds.map((s, k) => (k === i ? { ...s, ...patch } : s)).map((s) => ({ ...s, a: Math.max(0, Math.min(s.a, s.b - 0.1)), b: Math.min(duration, Math.max(s.b, s.a + 0.1)) }));
    setEdit({ ...editRef.current, speeds: list });
  };

  // Camera footage: upload, replace or remove.
  const importCamera = async () => {
    setError(null);
    setCamImport(0);
    try {
      const job = platform.cameraImport(take);
      const off = await job.onProgress((p) => p >= 0 && setCamImport(p));
      const got = await job.promise.finally(off);
      if (got) {
        await reload();
        setCamera({ on: true });
      }
    } catch (e) {
      setError(`The camera footage could not be added: ${errorMessage(e)}`);
    } finally {
      setCamImport(null);
    }
  };
  const removeCamera = () =>
    void platform
      .cameraRemove(take)
      .then(reload)
      .catch((e: unknown) => setError(errorMessage(e)));

  /** Drag the camera bubble: it becomes placed by hand where it is let go. */
  const dragCamera = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const stage = e.currentTarget.closest(".take-stage");
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const box = e.currentTarget.getBoundingClientRect();
    const start = { x: (box.left + box.width / 2 - r.left) / r.width, y: (box.top + box.height / 2 - r.top) / r.height };
    const x0 = e.clientX;
    const y0 = e.clientY;
    setTool("camera");
    const move = (ev: PointerEvent) => setCamera({ spot: "custom", x: start.x + (ev.clientX - x0) / r.width, y: start.y + (ev.clientY - y0) / r.height }, "cam-drag");
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // The picture is as large as the canvas allows while keeping the video's shape.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setRoom({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [info]);

  const seekTo = (t: number) => {
    const v = video.current;
    if (v) v.currentTime = Math.min(duration, Math.max(0, t));
  };
  const seekFromPointer = (e: ReactPointerEvent) => {
    const r = lanes.current?.getBoundingClientRect();
    if (r) seekTo(((e.clientX - r.left) / r.width) * duration);
  };

  // Keys anywhere in the editor: Space plays, arrows step a second, Home/End jump. Controls that
  // use these keys themselves (sliders, radios, text) keep them.
  const splitHere = () => setEdit(addSplit(editRef.current, time, duration));
  /** One zoom's change merged with what it had; back to "same as all" when nothing is left. */
  const zoomChange = (z: { start: number; end: number }, patch: { zoom?: number; off?: boolean }, key = "") => {
    const cur = editRef.current.zooms.find((x) => x.at >= z.start && x.at < z.end);
    const next = { zoom: cur?.zoom, off: cur?.off, ...patch };
    const clean = { ...(next.zoom !== undefined && Math.abs(next.zoom - zl.depth) > 1e-6 ? { zoom: next.zoom } : {}), ...(next.off ? { off: true } : {}) };
    setEdit(editZoom(editRef.current, z, Object.keys(clean).length ? clean : null), key);
  };
  /** Delete key: removes (or brings back) the selected piece, turns the selected zoom off/on, or
   *  removes the selected mark, zoom placed by hand or sound. */
  const removeSel = () => {
    if (selMark) deleteMark(selMark);
    else if (sel?.kind === "piece") {
      const p = pieces(duration, editRef.current.splits)[sel.i];
      if (p) setEdit(togglePiece(editRef.current, p, duration));
    } else if (sel?.kind === "zoom") {
      const z = zoomList[sel.i];
      if (z) zoomChange(z, { off: !z.off });
    } else if (sel?.kind === "manual") {
      setEdit({ ...editRef.current, added: editRef.current.added.filter((m) => m.id !== sel.id) });
      setSel(null);
    } else if (sel?.kind === "audio") deleteClip(sel.id);
  };
  const keyState = useRef({ toggle, seekTo, time, splitHere, removeSel, undo, redo, clear: () => (setSel(null), setPickSpot(null)) });
  keyState.current = { toggle, seekTo, time, splitHere, removeSel, undo, redo, clear: () => (setSel(null), setPickSpot(null)) };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const k = keyState.current;
      if (el?.closest("input, textarea, select")) return;
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "z") (e.shiftKey ? k.redo : k.undo)();
        else if (key === "y") k.redo();
        else return;
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "s" || e.key === "S") k.splitHere();
      else if (e.key === "Delete" || e.key === "Backspace") k.removeSel();
      else if (e.key === "Escape") k.clear();
      else if (el?.closest("[role=slider], [role=radiogroup]")) return;
      else if (e.key === " " && el?.tagName !== "BUTTON") k.toggle();
      else if (e.key === "ArrowRight") k.seekTo(k.time + 1);
      else if (e.key === "ArrowLeft") k.seekTo(k.time - 1);
      else if (e.key === "Home") k.seekTo(0);
      else if (e.key === "End") k.seekTo(Number.POSITIVE_INFINITY);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Panel sizes (Studio-style splitters), remembered on this computer; double-click resets.
  const [sizes, setSizes] = useState<Sizes>(loadSizes);
  useEffect(() => store(SIZES_KEY, sizes), [sizes]);
  const startResize = (key: keyof Sizes, dir: 1 | -1, axis: "x" | "y") => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const from = axis === "x" ? e.clientX : e.clientY;
    const base = sizes[key];
    const [lo, hi] = LIMITS[key];
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
    const move = (ev: PointerEvent) => {
      const d = ((axis === "x" ? ev.clientX : ev.clientY) - from) * dir;
      setSizes((s) => ({ ...s, [key]: Math.round(Math.min(hi, Math.max(lo, base + d))) }));
    };
    const up = () => {
      document.body.classList.remove("resizing-x", "resizing-y");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [pane, setPane] = useState<Pane>("details");

  if (!info) return <div className="page">{error ? <p className="error-text">{error}</p> : <p className="muted-note">Opening the recording…</p>}</div>;
  const rec = { width: data?.width ?? 1920, height: data?.height ?? 1080 };
  // The stage has the video's shape; the picture sits in it where the export puts it.
  const L = layout(rec, style);
  const ar = L.out.width / L.out.height;
  const fcss = L.framed ? frameCss(style.frame ?? PLAIN_FRAME, L.out, L.box, url) : null;
  const stageW = room.w && room.h ? Math.min(room.w, room.h * ar) : 0;
  const stageH = stageW / ar;
  const camera = style.camera;
  const cb = cameraBox(camera, L.out.width, L.out.height);
  const pctW = (v: number) => `${(v / L.out.width) * 100}%`;
  const pctH = (v: number) => `${(v / L.out.height) * 100}%`;
  const cropVideo: CSSProperties | undefined = crop ? { position: "absolute", width: `${100 / crop.w}%`, height: `${100 / crop.h}%`, left: `${(-crop.x / crop.w) * 100}%`, top: `${(-crop.y / crop.h) * 100}%`, objectFit: "fill" } : undefined;
  const zooms = zl.on ? zoomList.filter((r) => !r.off) : [];
  const parts = pieces(duration, edit.splits);
  const selPiece = sel?.kind === "piece" ? parts[sel.i] : undefined;
  const selZoom = sel?.kind === "zoom" ? zoomList[sel.i] : undefined;
  const selManual = sel?.kind === "manual" ? manual.find((m) => m.id === sel.id) : undefined;
  const selClip = sel?.kind === "audio" ? edit.audio.find((c) => c.id === sel.id) : undefined;
  const selPieceCut = selPiece ? isCut(edit.cuts, (selPiece.a + selPiece.b) / 2) : false;
  const at = (t: number) => `${(t / (duration || 1)) * 100}%`;
  const width = (a: number, b: number) => `calc(${((Math.min(b, duration) - a) / (duration || 1)) * 100}% - 2px)`;
  const ticks = rulerTicks(duration);
  const zoomNow = viewAt(keys, time).z;
  const panes: ReadonlyArray<{ id: Pane; icon: typeof PhotoIcon; label: string }> = [
    { id: "details", icon: InformationCircleIcon, label: "Details" },
    { id: "clicks", icon: ListBulletIcon, label: "Clicks" },
    { id: "markers", icon: FlagIcon, label: "Markers" },
    { id: "quiet", icon: BoltIcon, label: "Quiet" },
    { id: "speed", icon: ClockIcon, label: "Speed" },
    { id: "marks", icon: PaintBrushIcon, label: "Marks" },
  ];
  const tabs: ReadonlyArray<{ id: Tool; icon: typeof PhotoIcon; label: string }> = [
    { id: "zoom", icon: MagnifyingGlassPlusIcon, label: "Zoom" },
    { id: "clicks", icon: CursorArrowRaysIcon, label: "Cursor" },
    { id: "sound", icon: SpeakerWaveIcon, label: "Sound" },
    { id: "frame", icon: PhotoIcon, label: "Frame" },
    { id: "camera", icon: VideoCameraIcon, label: "Camera" },
  ];
  const created = data?.createdAt ? new Date(data.createdAt) : null;
  const fullOut = layout(rec, style, 1).out;
  const scale = exportScale(exp, fullOut.width);
  const outSize = layout(rec, style, scale).out;
  const markIcon = (m: Mark) => (m.kind === "blur" ? EyeSlashIcon : m.kind === "text" ? ChatBubbleBottomCenterTextIcon : m.kind === "image" ? PhotoIcon : PaintBrushIcon);
  const markName = (m: Mark) => (m.kind === "blur" ? "Blur" : m.kind === "text" ? m.text || "Text" : m.kind === "image" ? "Picture" : (SHAPES.find((s) => s.id === m.shape)?.label ?? "Shape"));
  const hasAudioLane = edit.audio.length > 0;

  return (
    <main className="ed" ref={shell} style={{ "--lib": `${sizes.lib}px`, "--insp": `${sizes.insp}px`, "--tl": `${sizes.tl}px` } as CSSProperties}>
      <div className="ed-split v s1" role="separator" aria-orientation="vertical" aria-label="Resize the side panel" onPointerDown={startResize("lib", 1, "x")} onDoubleClick={() => setSizes((s) => ({ ...s, lib: DEFAULT_SIZES.lib }))} />
      <div className="ed-split v s2" role="separator" aria-orientation="vertical" aria-label="Resize the inspector" onPointerDown={startResize("insp", -1, "x")} onDoubleClick={() => setSizes((s) => ({ ...s, insp: DEFAULT_SIZES.insp }))} />
      <div className="ed-split h s3" role="separator" aria-orientation="horizontal" aria-label="Resize the timeline" onPointerDown={startResize("tl", -1, "y")} onDoubleClick={() => setSizes((s) => ({ ...s, tl: DEFAULT_SIZES.tl }))} />

      <nav className="ed-rail glide" aria-label="Recording" style={{ "--rail-i": panes.findIndex((p) => p.id === pane) } as CSSProperties}>
        <span className="ed-rail-indicator" aria-hidden />
        <span className="glide-pill" aria-hidden />
        {panes.map((p) => (
          <button key={p.id} className={pane === p.id ? "ed-rail-btn on" : "ed-rail-btn"} onClick={() => setPane(p.id)} aria-pressed={pane === p.id} title={p.label}>
            <p.icon aria-hidden />
            <span>{p.label}</span>
          </button>
        ))}
      </nav>

      <aside className="ed-library" aria-label={panes.find((p) => p.id === pane)?.label}>
        {pane === "details" && (
          <div className="ed-pane" key="details">
            <div className="ed-pane-head">
              <h3>Details</h3>
            </div>
            <div className="ed-card ed-file">
              <span className="ed-file-icon" aria-hidden>
                <FilmIcon />
              </span>
              <span className="ed-file-text">
                <strong title={info.name}>{info.name}</strong>
                <em>{created ? created.toLocaleString() : "Recording"}</em>
              </span>
            </div>
            <dl className="ed-stats">
              <div>
                <dt>Length</dt>
                <dd>{!isPlain(segs) ? `${formatTime(kept)} of ${formatTime(duration)}` : formatTime(duration)}</dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{data ? `${data.width}×${data.height}` : "—"}</dd>
              </div>
              <div>
                <dt>Frame rate</dt>
                <dd>{data ? `${data.fps} fps` : "—"}</dd>
              </div>
              <div>
                <dt>On disk</dt>
                <dd>{bytes(info.bytes)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{data?.source === "window" ? "Window" : data?.source === "area" ? "Area" : data?.source === "import" ? "Video file" : "Screen"}</dd>
              </div>
              <div>
                <dt>Camera</dt>
                <dd>{info.camera ? "Yes" : "No"}</dd>
              </div>
            </dl>
            <div className="ed-card glide">
              <span className="glide-pill" aria-hidden />
              <div className="ed-card-head">
                <strong>Exports</strong>
                <span>{info.exports.length || "None yet"}</span>
              </div>
              {info.exports.map((x) => (
                <button key={x} className="ed-row" onClick={() => void platform.reveal(x)} title="Show in folder">
                  <ArrowDownTrayIcon aria-hidden />
                  <span>{x.split(/[\\/]/).pop()}</span>
                </button>
              ))}
            </div>
            <div className="ed-pane-actions glide">
              <span className="glide-pill" aria-hidden />
              <button className="btn" onClick={() => void platform.reveal(exported ?? info.video ?? info.path)}>
                <FolderOpenIcon aria-hidden /> Show in folder
              </button>
              <button className="btn" onClick={() => void saveProject()} title="Save this edit as a .capturely file to open again later">
                <DocumentArrowDownIcon aria-hidden /> Save project
              </button>
              {confirmDelete ? (
                <button className="btn danger" onClick={() => void platform.takeDelete(take).then(onDeleted, (e: unknown) => setError(errorMessage(e)))} onBlur={() => setConfirmDelete(false)}>
                  <TrashIcon aria-hidden /> Delete for good
                </button>
              ) : (
                <button className="btn ghost" onClick={() => setConfirmDelete(true)}>
                  <TrashIcon aria-hidden /> Delete
                </button>
              )}
            </div>
          </div>
        )}

        {pane === "clicks" && (
          <div className="ed-pane" key="clicks">
            <div className="ed-pane-head">
              <h3>Clicks</h3>
              <span className="ed-count">{data?.clicks.length ?? 0}</span>
            </div>
            {data?.clicks.length ? (
              <div className="ed-list glide">
                <span className="glide-pill" aria-hidden />
                {data.clicks.map((c, i) => (
                  <button key={c.t} className={time >= c.t && time < c.t + 1 ? "ed-row on" : "ed-row"} onClick={() => seekTo(c.t)}>
                    <CursorArrowRaysIcon aria-hidden />
                    <span>Click {i + 1}</span>
                    <time>{stamp(c.t)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <p className="ed-empty">No clicks in this recording.</p>
            )}
          </div>
        )}

        {pane === "markers" && (
          <div className="ed-pane" key="markers">
            <div className="ed-pane-head">
              <h3>Markers</h3>
              <span className="ed-count">{data?.markers.length ?? 0}</span>
            </div>
            {data?.markers.length ? (
              <div className="ed-list glide">
                <span className="glide-pill" aria-hidden />
                {data.markers.map((m, i) => (
                  <button key={m} className="ed-row" onClick={() => seekTo(m)}>
                    <FlagIcon aria-hidden />
                    <span>Marker {i + 1}</span>
                    <time>{stamp(m)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <p className="ed-empty">No markers. Add them with the flag on the capture bar while recording.</p>
            )}
          </div>
        )}

        {pane === "quiet" && (
          <div className="ed-pane" key="quiet">
            <div className="ed-pane-head">
              <h3>Quiet parts</h3>
              {quiet && <span className="ed-count">{quiet.length}</span>}
            </div>
            <p className="ed-hint">Stretches where the picture stays still, no one speaks and the mouse rests. Speed them up or cut them.</p>
            <div className="ed-card">
              <div className="ed-field">
                <span>At least</span>
                <Segmented wide label="Shortest quiet part" value={quietMin} onChange={setQuietMin} options={[2, 3, 5].map((v) => ({ value: v, label: `${v} s` }))} />
              </div>
              <button className="btn primary" onClick={() => void findQuiet()} disabled={finding !== null || !data}>
                <BoltIcon aria-hidden /> {finding !== null ? `Looking… ${Math.round(finding * 100)}%` : quiet ? "Look again" : "Find quiet parts"}
              </button>
            </div>
            {quiet &&
              (quiet.length ? (
                <>
                  <div className="ed-card">
                    <div className="ed-field">
                      <span>Speed up by</span>
                      <Segmented wide label="Speed up by" value={quietRate} onChange={setQuietRate} options={SPEEDS.map((r) => ({ value: r, label: rateLabel(r) }))} />
                    </div>
                    <div className="ed-pane-actions glide">
                      <span className="glide-pill" aria-hidden />
                      <button className="btn" onClick={() => setEdit(addSpeeds(editRef.current, quiet, quietRate))}>
                        <ForwardIcon aria-hidden /> Speed up all
                      </button>
                      <button className="btn ghost" onClick={() => setEdit({ ...editRef.current, cuts: mergeSpans([...editRef.current.cuts, ...quiet], duration) })}>
                        <ScissorsIcon aria-hidden /> Cut all
                      </button>
                    </div>
                  </div>
                  <div className="ed-list glide">
                    <span className="glide-pill" aria-hidden />
                    {quiet.map((q) => {
                      const sp = edit.speeds.find((x) => x.a < q.b && x.b > q.a);
                      const cut = isCut(edit.cuts, (q.a + q.b) / 2);
                      return (
                        <div key={q.a} className="ed-quiet">
                          <button className="ed-row" onClick={() => seekTo(q.a)}>
                            <BoltIcon aria-hidden />
                            <span>
                              {stamp(q.a)}–{stamp(q.b)}
                              <em>{cut ? "Cut" : sp ? `${rateLabel(sp.rate)} speed` : `${(q.b - q.a).toFixed(1)} s`}</em>
                            </span>
                          </button>
                          <button className={sp ? "ed-icon on" : "ed-icon"} onClick={() => setEdit(sp ? removeSpeeds(editRef.current, [q]) : addSpeeds(editRef.current, [q], quietRate))} aria-label={sp ? "Normal speed" : "Speed up"} title={sp ? "Back to normal speed" : `Speed up ${quietRate}×`}>
                            <ForwardIcon aria-hidden />
                          </button>
                          <button className={cut ? "ed-icon on" : "ed-icon"} onClick={() => setEdit(togglePiece(editRef.current, q, duration))} aria-label={cut ? "Bring back" : "Cut"} title={cut ? "Bring back" : "Cut it"}>
                            <ScissorsIcon aria-hidden />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <p className="ed-empty">No quiet parts of {quietMin} s or longer.</p>
              ))}
          </div>
        )}

        {pane === "speed" && (
          <div className="ed-pane" key="speed">
            <div className="ed-pane-head">
              <h3>Speed</h3>
              <span className="ed-count">{edit.speeds.length}</span>
            </div>
            <p className="ed-hint">Play a stretch faster or in slow motion. Added at the playhead for 3 s; slowed sound keeps its pitch.</p>
            <div className="ed-card">
              <div className="ed-field">
                <span>Speed</span>
                <Segmented wide label="Speed" value={speedRate} onChange={setSpeedRate} options={RATES.map((r) => ({ value: r, label: rateLabel(r) }))} />
              </div>
              <button className="btn primary" onClick={() => setEdit(addSpeeds(editRef.current, [{ a: time, b: Math.min(duration, time + 3) }], speedRate))} disabled={!data || time > duration - 0.2}>
                <PlusIcon aria-hidden /> Add at {stamp(time)}
              </button>
            </div>
            {edit.speeds.map((s, i) => (
              <div key={`${s.a}-${i}`} className="ed-card ed-mark on">
                <button className="ed-row" onClick={() => seekTo(s.a)}>
                  <ClockIcon aria-hidden />
                  <span>
                    {s.rate < 1 ? "Slow motion" : "Faster"} · {rateLabel(s.rate)}
                    <em>
                      {stamp(s.a)}–{stamp(s.b)}
                    </em>
                  </span>
                </button>
                <Segmented wide label="Speed of this stretch" value={s.rate} onChange={(rate) => changeSpeed(i, { rate })} options={RATES.map((r) => ({ value: r, label: rateLabel(r) }))} />
                <div className="ed-mark-times">
                  <button className="btn ghost" onClick={() => changeSpeed(i, { a: time })} title="Start at the playhead">
                    From {stamp(s.a)}
                  </button>
                  <button className="btn ghost" onClick={() => changeSpeed(i, { b: time })} title="End at the playhead">
                    To {stamp(s.b)}
                  </button>
                  <button className="ed-icon" onClick={() => setEdit({ ...editRef.current, speeds: editRef.current.speeds.filter((_, k) => k !== i) })} aria-label="Back to normal speed" title="Back to normal speed">
                    <TrashIcon aria-hidden />
                  </button>
                </div>
              </div>
            ))}
            {!edit.speeds.length && <p className="ed-empty">Everything plays at normal speed.</p>}
          </div>
        )}

        {pane === "marks" && (
          <div className="ed-pane" key="marks">
            <div className="ed-pane-head">
              <h3>Marks</h3>
              <span className="ed-count">{edit.marks.length}</span>
            </div>
            <div className="ed-pane-actions glide ed-mark-add">
              <span className="glide-pill" aria-hidden />
              <button className="btn" onClick={() => addMark("blur")}>
                <EyeSlashIcon aria-hidden /> Blur
              </button>
              <button className="btn" onClick={() => addMark("text")}>
                <ChatBubbleBottomCenterTextIcon aria-hidden /> Text
              </button>
              <button className="btn" onClick={() => void addPicture()}>
                <PhotoIcon aria-hidden /> Picture
              </button>
              <button className="btn" onClick={() => addMark("shape")}>
                <PaintBrushIcon aria-hidden /> Shape
              </button>
            </div>
            <p className="ed-hint">Added at the playhead for 3 s. Drag on the picture to move; drag the corner dot to resize (an arrow's end). A blur zooms with the recording; the others stay put.</p>
            {edit.marks.some((m) => m.kind === "text") && caps && !caps.font && <p className="ed-note warn">No font was found on this computer, so text is left out of exports.</p>}
            {edit.marks.map((m) => {
              const on = m.id === selMark;
              const Icon = markIcon(m);
              return (
                <div key={m.id} className={on ? "ed-card ed-mark on" : "ed-card ed-mark"}>
                  <button className="ed-row" onClick={() => (setSelMark(on ? null : m.id), seekTo(m.a))}>
                    <Icon aria-hidden />
                    <span>
                      {markName(m)}
                      <em>
                        {stamp(m.a)}–{stamp(m.b)}
                      </em>
                    </span>
                  </button>
                  {on && (
                    <>
                      {m.kind === "text" && (
                        <>
                          <input className="ui-input" value={m.text ?? ""} maxLength={120} onChange={(e) => changeMark(m.id, { text: e.target.value }, `text-${m.id}`)} aria-label="Text" placeholder="Text" />
                          <Slider label="Size" value={m.size ?? 0.045} min={0.02} max={0.12} step={0.005} format={(v) => pct(v * 10)} onChange={(v) => changeMark(m.id, { size: v }, `size-${m.id}`)} />
                        </>
                      )}
                      {m.kind === "shape" && (
                        <>
                          <Segmented wide label="Shape" value={m.shape ?? "rect"} onChange={(shape) => changeMark(m.id, shape === "arrow" ? { shape, fill: false } : { shape, w: Math.abs(m.w), h: Math.abs(m.h) })} options={SHAPES.map((s) => ({ value: s.id, label: s.label }))} />
                          <div className="ui-swatches" role="radiogroup" aria-label="Colour">
                            {SHAPE_COLORS.map((c) => (
                              <button key={c} role="radio" aria-checked={m.color === c} aria-label={c} title={c} className={m.color === c ? "ui-swatch on" : "ui-swatch"} onClick={() => changeMark(m.id, { color: c })}>
                                <i style={{ background: c }} aria-hidden />
                              </button>
                            ))}
                          </div>
                          <Slider label="Line" value={m.stroke ?? 0.008} min={0.002} max={0.03} step={0.001} format={(v) => pct(v * 10)} onChange={(v) => changeMark(m.id, { stroke: v }, `stroke-${m.id}`)} />
                          {m.shape !== "arrow" && (
                            <div className="ed-line">
                              <span>
                                <strong>Filled</strong>
                              </span>
                              <Switch on={!!m.fill} label="Filled" onChange={(fill) => changeMark(m.id, { fill })} />
                            </div>
                          )}
                        </>
                      )}
                      <div className="ed-mark-times">
                        <button className="btn ghost" onClick={() => changeMark(m.id, { a: time })} title="Start at the playhead">
                          From {stamp(m.a)}
                        </button>
                        <button className="btn ghost" onClick={() => changeMark(m.id, { b: time })} title="End at the playhead">
                          To {stamp(m.b)}
                        </button>
                        <button className="ed-icon" onClick={() => deleteMark(m.id)} aria-label="Delete" title="Delete (Delete key)">
                          <TrashIcon aria-hidden />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </aside>

      <section className="ed-player">
        <header className="ed-player-head">
          <span className="ed-player-title">Preview</span>
          <span className="ed-chip">{`${L.out.width}×${L.out.height}`}</span>
          {zooms.length + manual.length > 0 && <span className="ed-chip accent">{zooms.filter((r) => !coveredByHand(r)).length + manual.length} zooms</span>}
          <span className="grow" />
          <Dropdown
            label="Keyboard shortcuts"
            width={340}
            trigger={({ open, toggle }) => (
              <button className={open ? "ed-icon on" : "ed-icon"} onClick={toggle} aria-expanded={open} aria-haspopup="dialog" aria-label="Keyboard shortcuts" title="Keyboard shortcuts">
                <QuestionMarkCircleIcon aria-hidden />
              </button>
            )}
          >
            {() => (
              <>
                <span className="ui-pop-label">In the editor</span>
                <dl className="ed-keys">
                  {EDITOR_KEYS.map(([k, what]) => (
                    <div key={k}>
                      <dt>{what}</dt>
                      <dd>
                        <kbd>{k}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
                <span className="ui-pop-label">From any app</span>
                <dl className="ed-keys">
                  {hotkeys.map((h) => (
                    <div key={h.action}>
                      <dt>{HOTKEY_LABEL[h.action]}</dt>
                      <dd>
                        <kbd className={h.ready ? "" : "taken"}>{h.keys}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="ui-pop-empty">Change the keys from any app in the capture bar's settings.</p>
                <button className="btn ghost" onClick={() => void platform.openUrl(FEEDBACK_URL)}>
                  <ChatBubbleLeftRightIcon aria-hidden /> Report a problem or an idea
                </button>
              </>
            )}
          </Dropdown>
          <Dropdown
            label="Presets"
            width={300}
            trigger={({ open, toggle }) => (
              <button className={open ? "btn ghost ed-drop open" : "btn ghost ed-drop"} onClick={toggle} aria-expanded={open} aria-haspopup="dialog">
                <BookmarkIcon aria-hidden /> Presets <ChevronDownIcon className="ed-chev" aria-hidden />
              </button>
            )}
          >
            {(close) => (
              <>
                <span className="ui-pop-label">Save current look as</span>
                <form
                  className="ui-pop-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveLook();
                  }}
                >
                  <input className="ui-input" value={presetName} onChange={(e) => setPresetName(e.target.value)} placeholder="Preset name" maxLength={40} aria-label="Preset name" autoFocus />
                  <button className="btn primary" type="submit" disabled={!presetName.trim()}>
                    Save
                  </button>
                </form>
                <span className="ui-pop-label">Saved presets</span>
                {presets.length ? (
                  <div className="ui-pop-list glide">
                    <span className="glide-pill" aria-hidden />
                    {presets.map((p) => (
                      <div key={p.name} className="ed-preset">
                        <button
                          className="ed-row"
                          onClick={() => {
                            applyLook(p);
                            close();
                          }}
                          title="Use this look"
                        >
                          <BookmarkIcon aria-hidden />
                          <span>
                            {p.name}
                            <em>
                              {p.style.zoom.on ? `Zoom ${p.style.zoom.depth.toFixed(1)}×` : "No zoom"} · {p.style.frame ? "Frame" : "No frame"} · {p.style.aspect === "auto" ? "" : `${p.style.aspect} · `}
                              {p.export.format.toUpperCase()} {QUALITIES.find((q) => q.id === p.export.quality)?.label}
                            </em>
                          </span>
                        </button>
                        <button className="ed-icon" onClick={() => setPresets((list) => list.filter((x) => x.name !== p.name))} aria-label={`Delete ${p.name}`} title="Delete this preset">
                          <TrashIcon aria-hidden />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="ui-pop-empty">No presets yet. Save the zoom, cursor, frame, camera, shape and export choices under a name.</p>
                )}
              </>
            )}
          </Dropdown>
          <Dropdown
            label="Export"
            width={380}
            trigger={({ open, toggle }) => (
              <button className={open ? "ed-export open" : "ed-export"} disabled={!data} onClick={toggle} aria-expanded={open} aria-haspopup="dialog" style={{ "--p": exporting ?? 0 } as CSSProperties}>
                <i aria-hidden />
                <ArrowDownTrayIcon aria-hidden />
                <span>{exporting !== null ? `Exporting ${Math.round(exporting * 100)}%` : "Export"}</span>
                <ChevronDownIcon className="ed-chev" aria-hidden />
              </button>
            )}
          >
            {(close) => (
              <>
                <span className="ui-pop-label">Export</span>
                <Segmented wide label="Format" value={exp.format} onChange={(format) => setExp((s) => validExport({ ...s, format, fps: format === s.format ? s.fps : format === "gif" ? 15 : 60 }))} options={[{ value: "mp4", label: "MP4", sub: "Video with sound" }, { value: "gif", label: "GIF", sub: "Silent loop" }]} />
                {exp.format === "mp4" ? (
                  <>
                    <span className="ui-pop-label">Quality</span>
                    <Segmented
                      wide
                      label="Quality"
                      value={exp.quality}
                      onChange={(quality) => setExp((s) => ({ ...s, quality }))}
                      options={QUALITIES.map((q) => {
                        const z = layout(rec, style, qualityScale(q.id)).out;
                        return { value: q.id, label: q.label, sub: `${z.width}×${z.height}` };
                      })}
                    />
                    <span className="ui-pop-label">Encoding</span>
                    <Segmented wide label="Encoding" value={exp.encoding} onChange={(encoding) => setExp((s) => ({ ...s, encoding }))} options={ENCODINGS.map((e) => ({ value: e.id, label: e.label }))} />
                  </>
                ) : (
                  <>
                    <span className="ui-pop-label">Size</span>
                    <Segmented wide label="GIF size" value={exp.gifWidth} onChange={(gifWidth) => setExp((s) => ({ ...s, gifWidth }))} options={GIF_WIDTHS.map((w) => ({ value: w, label: w ? `${w}` : "Full", sub: w ? "px wide" : `${fullOut.width} px` }))} />
                    <div className="ed-line">
                      <span>
                        <strong>Loop</strong>
                        <em>{exp.gifLoop ? "Plays again and again" : "Plays once"}</em>
                      </span>
                      <Switch on={exp.gifLoop} label="Loop" onChange={(gifLoop) => setExp((s) => ({ ...s, gifLoop }))} />
                    </div>
                  </>
                )}
                <span className="ui-pop-label">Frame rate</span>
                <Segmented wide label="Frame rate" value={exp.fps} onChange={(fps) => setExp((s) => ({ ...s, fps }))} options={FPS_CHOICES[exp.format].map((f) => ({ value: f, label: data && f > data.fps ? `${f} · ${data.fps} max` : `${f} fps` }))} />
                <p className="ui-pop-empty">
                  {outSize.width}×{outSize.height} · {formatTime(kept)}
                  {style.aspect !== "auto" ? ` · ${style.aspect}` : ""}
                </p>
                <button
                  className="ui-pop-go"
                  disabled={exporting !== null || !data}
                  onClick={() => {
                    close();
                    void doExport();
                  }}
                >
                  <ArrowDownTrayIcon aria-hidden /> {exporting !== null ? `Exporting ${Math.round(exporting * 100)}%` : exp.format === "gif" ? "Export GIF" : "Export video"}
                </button>
              </>
            )}
          </Dropdown>
          {exporting !== null && (
            <button className="ed-icon" onClick={() => void stopExport.current?.().catch(() => undefined)} aria-label="Stop exporting" title="Stop exporting">
              <StopIcon aria-hidden />
            </button>
          )}
        </header>

        <div className="ed-stage" ref={canvas}>
          {stageW > 0 && (
            <div className={pickSpot ? "take-stage picking" : "take-stage"} style={{ width: stageW, aspectRatio: String(ar), containerType: "inline-size" }}>
              {fcss && <div className="take-bg" style={fcss.bg} aria-hidden />}
              <div className="take-picture" style={fcss ? fcss.picture : undefined} onPointerDownCapture={pickOnPicture}>
                <div className="take-zoom" ref={zoomEl}>
                  <video ref={video} style={cropVideo} src={info.video ? platform.mediaUrl(info.video) : undefined} onLoadedMetadata={(e) => setVideoLen(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)} onEnded={() => setPlaying(false)} onClick={() => !pickSpot && toggle()} preload="auto" />
                  {edit.marks
                    .filter((m) => m.kind === "blur" && (inMark(m, time) || m.id === selMark))
                    .map((m) => (
                      <div key={m.id} className={["take-blur", m.id === selMark ? "sel" : "", inMark(m, time) ? "" : "off"].join(" ").trim()} style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, width: `${m.w * 100}%`, height: `${m.h * 100}%` }} onPointerDown={dragMark(m, "move")}>
                        {m.id === selMark && <i className="take-handle" onPointerDown={dragMark(m, "size")} aria-hidden />}
                      </div>
                    ))}
                  {smooth && look.on && <img ref={cursorEl} className="take-cursor" src={cursorImg} alt="" style={{ height: `${cursorImageShare(look.size) * 100}%` }} draggable={false} />}
                </div>
                {ringNow.map((r) => (
                  <i key={r.k} className="take-ring" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }} />
                ))}
                {selManual && time >= selManual.a && time < selManual.b && <i className="take-spot" style={{ left: `${(((selManual.x - zoomView(viewAt(keys, time).fx, zoomNow)) * zoomNow) * 100).toFixed(2)}%`, top: `${(((selManual.y - zoomView(viewAt(keys, time).fy, zoomNow)) * zoomNow) * 100).toFixed(2)}%` }} aria-hidden />}
              </div>
              {info.camera && camera.on && (
                <span ref={camBox} className="take-cam" style={{ left: pctW(cb.x), top: pctH(cb.y), width: pctW(cb.size), borderRadius: `${camera.round * 50}%`, boxShadow: camera.shadow > 0.01 ? `0 ${(cb.size * 0.04 * stageW) / L.out.width}px ${(cb.size * 0.2 * stageW) / L.out.width}px rgba(0,0,0,${0.7 * camera.shadow})` : "none", transformOrigin: `${cb.ax === "center" ? "center" : cb.ax} ${cb.ay === "center" ? "center" : cb.ay}` }} onPointerDown={dragCamera} title="Drag to place the camera">
                  <video ref={cam} src={platform.mediaUrl(info.camera)} muted preload="auto" style={{ transform: camera.mirror ? "scaleX(-1)" : "none", borderRadius: `${camera.round * 50}%` }} />
                </span>
              )}
              {edit.marks
                .filter((m) => (m.kind === "image" || m.kind === "shape") && (inMark(m, time) || m.id === selMark))
                .map((m) => {
                  const box = m.kind === "image" ? imageBox(m, L.out.width, L.out.height) : shapeSvg(m, L.out.width, L.out.height);
                  const src = m.kind === "image" ? url(m.file ?? "") : `data:image/svg+xml;charset=utf-8,${encodeURIComponent((box as ReturnType<typeof shapeSvg>).svg)}`;
                  const end = m.kind === "shape" && m.shape === "arrow" ? { left: `${(m.x + m.w) * 100}%`, top: `${(m.y + m.h) * 100}%` } : null;
                  return (
                    <div key={m.id} className={["take-art", m.id === selMark ? "sel" : "", inMark(m, time) ? "" : "off"].join(" ").trim()}>
                      <img src={src} alt="" draggable={false} style={{ left: pctW(box.x), top: pctH(box.y), width: pctW(box.w), height: pctH(box.h) }} onPointerDown={dragMark(m, "move")} />
                      {m.id === selMark && <i className="take-handle" style={end ?? { left: pctW(box.x + box.w), top: pctH(box.y + box.h) }} onPointerDown={dragMark(m, "size")} aria-hidden />}
                    </div>
                  );
                })}
              {edit.marks
                .filter((m) => m.kind === "text" && (inMark(m, time) || m.id === selMark))
                .map((m) => {
                  const px = (m.size ?? 0.045) * stageH;
                  return (
                    <div key={m.id} className={["take-text", m.id === selMark ? "sel" : "", inMark(m, time) ? "" : "off"].join(" ").trim()} style={{ left: `${m.x * 100}%`, top: `${m.y * 100}%`, fontSize: px, padding: px * 0.4 }} onPointerDown={dragMark(m, "move")}>
                      {m.text || "Text"}
                    </div>
                  );
                })}
            </div>
          )}
          {sounds.includes("system") && info.path && <audio ref={sysAudio} src={platform.mediaUrl(`${info.path}${sep}system.m4a`)} preload="auto" />}
          {sounds.includes("mic") && info.path && <audio ref={micAudio} src={platform.mediaUrl(`${info.path}${sep}mic.m4a`)} preload="auto" />}
          {edit.audio.map((c) => (
            <audio key={c.id} ref={(el) => void (el ? clipEls.current.set(c.id, el) : clipEls.current.delete(c.id))} src={url(c.file)} preload="auto" />
          ))}
          {(error || exported || note || pickSpot) && (
            <p className={error ? "ed-note error" : "ed-note"} role={error ? "alert" : "status"}>
              {error ?? (pickSpot ? "Click the picture where this zoom should go. Esc cancels." : (note ?? `Exported and checked: ${exported?.split(/[\\/]/).pop()}`))}
            </p>
          )}
        </div>

        <div className="ed-transport">
          <span className="ed-timecode">
            <span className="now">{stamp(time)}</span>
            <span className="total"> / {stamp(duration)}</span>
          </span>
          <div className="ed-transport-main glide">
            <span className="glide-pill" aria-hidden />
            <button className="ed-icon" onClick={() => seekTo(0)} aria-label="Go to the start" title="Go to the start (Home)">
              <BackwardIcon aria-hidden />
            </button>
            <button className="ed-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>
              {playing ? <PauseIcon aria-hidden /> : <PlayIcon aria-hidden />}
            </button>
            <button className="ed-icon" onClick={() => seekTo(duration)} aria-label="Go to the end" title="Go to the end (End)">
              <ForwardIcon aria-hidden />
            </button>
          </div>
          <span className="ed-transport-tools">
            <span className={zoomNow > 1.001 ? "ed-chip accent" : "ed-chip"} title="Zoom at the playhead">
              <MagnifyingGlassPlusIcon aria-hidden /> {zoomNow.toFixed(1)}×
            </span>
          </span>
        </div>
      </section>

      <aside className="ed-inspector" aria-label="Properties">
        <div className="ed-tabs glide" role="tablist" aria-label="Properties">
          <span className="glide-pill" aria-hidden />
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tool === t.id} aria-label={t.label} title={t.label} className={tool === t.id ? "ed-tab on" : "ed-tab"} onClick={() => setTool(t.id)}>
              <t.icon aria-hidden />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="ed-panel" role="tabpanel" key={tool}>
          {tool === "zoom" && (
            <>
              {selManual && (
                <>
                  <div className="ed-section-head">
                    <span>
                      Zoom by hand · {stamp(selManual.a)}–{stamp(selManual.b)}
                    </span>
                  </div>
                  <div className="ed-card ed-sel">
                    <Slider label="Zoom" value={selManual.zoom} min={1.1} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => changeManual(selManual.id, { zoom: v }, `mz-${selManual.id}`)} />
                    <Slider label="Across" value={selManual.x} min={0} max={1} step={0.01} format={pct} onChange={(x) => changeManual(selManual.id, { x }, `mx-${selManual.id}`)} />
                    <Slider label="Down" value={selManual.y} min={0} max={1} step={0.01} format={pct} onChange={(y) => changeManual(selManual.id, { y }, `my-${selManual.id}`)} />
                    <button className={pickSpot ? "btn primary" : "btn"} onClick={() => (seekTo(Math.max(time, selManual.a + 0.7)), setPickSpot(pickSpot ? null : selManual.id))}>
                      <ViewfinderCircleIcon aria-hidden /> {pickSpot ? "Click the picture…" : "Choose the spot on the picture"}
                    </button>
                    <div className="ed-mark-times">
                      <button className="btn ghost" onClick={() => changeManual(selManual.id, { a: time })} title="Start at the playhead">
                        From {stamp(selManual.a)}
                      </button>
                      <button className="btn ghost" onClick={() => changeManual(selManual.id, { b: time })} title="End at the playhead">
                        To {stamp(selManual.b)}
                      </button>
                      <button className="ed-icon" onClick={removeSel} aria-label="Delete this zoom" title="Delete (Delete key)">
                        <TrashIcon aria-hidden />
                      </button>
                    </div>
                  </div>
                </>
              )}
              {selZoom && (
                <>
                  <div className="ed-section-head">
                    <span>
                      Selected zoom · {stamp(selZoom.start)}–{stamp(selZoom.end)}
                    </span>
                    {selZoom.edited && (
                      <button className="ed-reset" onClick={() => setEdit(editZoom(editRef.current, selZoom, null))}>
                        Reset
                      </button>
                    )}
                  </div>
                  <div className="ed-card ed-sel">
                    <div className="ed-line">
                      <span>
                        <strong>This zoom</strong>
                        <em>{selZoom.off ? "Off · the picture stays whole here" : selZoom.edited ? "Changed for this zoom only" : "Same as all zooms"}</em>
                      </span>
                      <Switch on={!selZoom.off} label="This zoom" onChange={(on) => zoomChange(selZoom, { off: !on })} />
                    </div>
                    {!selZoom.off && <Slider label="Zoom" value={selZoom.zoom} min={1.2} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => zoomChange(selZoom, { zoom: v }, `zoom-${sel?.kind === "zoom" ? sel.i : ""}`)} />}
                  </div>
                </>
              )}
              <div className="ed-section-head">
                <span>Zooms by hand</span>
                {manual.length > 0 && (
                  <button className="ed-reset" onClick={() => setEdit({ ...editRef.current, added: [] })}>
                    Remove all
                  </button>
                )}
              </div>
              <div className="ed-card">
                <div className="ed-pane-actions glide">
                  <span className="glide-pill" aria-hidden />
                  <button className="btn" onClick={addManual} disabled={!data}>
                    <PlusIcon aria-hidden /> Add zoom at {stamp(time)}
                  </button>
                  <button className="btn ghost" onClick={suggest} disabled={!path.length} title={path.length ? "Zoom where the pointer comes to rest" : "This recording has no pointer path"}>
                    <SparklesIcon aria-hidden /> Suggest zooms
                  </button>
                </div>
                <p className="ed-hint">{manual.length ? `${manual.length} placed by hand. They win over click zooms where they overlap.` : "Zoom in on any moment, even without a click."}</p>
              </div>
              <div className="ed-section-head">
                <span>Zoom on clicks</span>
                <button className="ed-reset" onClick={() => setZoom({ ...DEFAULT_STYLE.zoom })}>
                  Reset
                </button>
              </div>
              <div className="ed-card">
                <div className="ed-line">
                  <span>
                    <strong>Zoom on clicks</strong>
                    <em>{data?.clicks.length ? `${zooms.length} zoom${zooms.length === 1 ? "" : "s"}` : "No clicks in this recording"}</em>
                  </span>
                  <Switch on={zl.on} label="Zoom on clicks" onChange={(on) => setZoom({ on })} />
                </div>
              </div>
              {zl.on && (
                <div className="ed-card">
                  <Slider label="Depth" value={zl.depth} min={1.2} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(depth) => setZoom({ depth }, "zoom-depth")} />
                  <Slider label="Hold" value={zl.hold} min={0.5} max={4} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(hold) => setZoom({ hold }, "zoom-hold")} />
                  <div className="ed-field">
                    <span>When the mouse moves on</span>
                    <Segmented wide label="When the mouse moves on" value={zl.after} onChange={(after) => setZoom({ after })} options={[{ value: "follow", label: "Follow" }, { value: "zoomOut", label: "Zoom out" }]} />
                  </div>
                </div>
              )}
            </>
          )}

          {tool === "clicks" && (
            <>
              <div className="ed-section-head">
                <span>Clicks</span>
              </div>
              <div className="ed-card">
                <div className="ed-line">
                  <span>
                    <strong>Click rings</strong>
                    <em>{style.rings ? "A ring where you click" : "Off"}</em>
                  </span>
                  <Switch on={style.rings} label="Click rings" onChange={(rings) => setStyle({ rings })} />
                </div>
              </div>
              <p className="ed-hint">{data?.clicks.length ?? 0} clicks were recorded. Rings and zooms follow them.</p>
              <div className="ed-section-head">
                <span>Smooth cursor</span>
                {smooth && (
                  <button className="ed-reset" onClick={() => setEdit({ ...editRef.current, cursor: EMPTY_EDIT.cursor })}>
                    Reset
                  </button>
                )}
              </div>
              {smooth ? (
                <>
                  <div className="ed-card">
                    <div className="ed-line">
                      <span>
                        <strong>Smooth cursor</strong>
                        <em>{look.on ? "Drawn from the mouse path" : "No cursor in the video"}</em>
                      </span>
                      <Switch on={look.on} label="Smooth cursor" onChange={(on) => setEdit({ ...editRef.current, cursor: { ...look, on } })} />
                    </div>
                  </div>
                  {look.on && (
                    <>
                      <div className="ed-card">
                        <Slider label="Size" value={look.size} min={0.6} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(size) => setEdit({ ...editRef.current, cursor: { ...editRef.current.cursor, size } }, "cursor-size")} />
                        <Slider label="Smoothing" value={look.smooth} min={0} max={1} step={0.05} format={pct} onChange={(v) => setEdit({ ...editRef.current, cursor: { ...editRef.current.cursor, smooth: v } }, "cursor-smooth")} />
                      </div>
                      <div className="ed-section-head">
                        <span>Motion</span>
                      </div>
                      <div className="ed-card">
                        <Slider label="Click bounce" value={look.bounce} min={0} max={1} step={0.05} format={pct} onChange={(bounce) => setEdit({ ...editRef.current, cursor: { ...editRef.current.cursor, bounce } }, "cursor-bounce")} />
                        <Slider label="Sway" value={look.sway} min={0} max={1} step={0.05} format={pct} onChange={(sway) => setEdit({ ...editRef.current, cursor: { ...editRef.current.cursor, sway } }, "cursor-sway")} />
                        <Slider label="Motion blur" value={look.blur} min={0} max={1} step={0.05} format={pct} onChange={(blur) => setEdit({ ...editRef.current, cursor: { ...editRef.current.cursor, blur } }, "cursor-blur")} />
                        <div className="ed-line">
                          <span>
                            <strong>Loop</strong>
                            <em>{look.loop ? "Glides back to where it started" : "Ends where the mouse ended"}</em>
                          </span>
                          <Switch on={look.loop} label="Loop the cursor" onChange={(loop) => setEdit({ ...editRef.current, cursor: { ...editRef.current.cursor, loop } })} />
                        </div>
                      </div>
                      <p className="ed-hint">Loop suits a video or GIF that plays again and again: the cursor ends where it began.</p>
                    </>
                  )}
                </>
              ) : (
                <p className="ed-hint">This recording has its own cursor. Choose Cursor: Smooth in the capture bar's settings before recording to get a smooth, larger cursor with effects here.</p>
              )}
            </>
          )}

          {tool === "sound" && (
            <>
              <div className="ed-section-head">
                <span>Sound</span>
                <button className="ed-reset" onClick={() => setEdit({ ...editRef.current, sound: EMPTY_EDIT.sound })}>
                  Reset
                </button>
              </div>
              {!sounds.length && !info.audio ? (
                <p className="ed-hint">This recording has no sound of its own.</p>
              ) : (
                <>
                  <div className="ed-card">
                    {sounds.length ? (
                      sounds.map((n) => (
                        <Slider key={n} label={n === "mic" ? "Microphone" : "System sound"} value={n === "mic" ? edit.sound.mic : edit.sound.system} min={0} max={2} step={0.05} format={pct} onChange={(v) => setEdit({ ...editRef.current, sound: { ...editRef.current.sound, [n]: v } }, `vol-${n}`)} />
                      ))
                    ) : (
                      <Slider label="Volume" value={edit.sound.system} min={0} max={2} step={0.05} format={pct} onChange={(v) => setEdit({ ...editRef.current, sound: { ...editRef.current.sound, system: v } }, "vol-system")} />
                    )}
                  </div>
                  {(sounds.includes("mic") || !sounds.length) && (
                    <div className="ed-card">
                      <div className="ed-line">
                        <span>
                          <strong>{sounds.length ? "Clean up the microphone" : "Clean up noise"}</strong>
                          <em>{edit.sound.clean ? "Hiss and hum lowered when exporting" : "Off"}</em>
                        </span>
                        <Switch on={edit.sound.clean} label="Clean up noise" onChange={(clean) => setEdit({ ...editRef.current, sound: { ...editRef.current.sound, clean } })} />
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="ed-section-head">
                <span>Extra sound</span>
                <span className="ed-count">{edit.audio.length}</span>
              </div>
              <div className="ed-card">
                <button className="btn" onClick={() => void addSound()}>
                  <MusicalNoteIcon aria-hidden /> Add music or a voice-over at {stamp(time)}
                </button>
              </div>
              {edit.audio.map((c) => {
                const on = selClip?.id === c.id;
                return (
                  <div key={c.id} className={on ? "ed-card ed-mark on" : "ed-card ed-mark"}>
                    <button className="ed-row" onClick={() => (setSel(on ? null : { kind: "audio", id: c.id }), seekTo(c.a))}>
                      <MusicalNoteIcon aria-hidden />
                      <span>
                        {c.name}
                        <em>
                          {stamp(c.a)}–{stamp(c.a + c.len)}
                        </em>
                      </span>
                    </button>
                    {on && (
                      <>
                        <Slider label="Volume" value={c.volume} min={0} max={2} step={0.05} format={pct} onChange={(volume) => changeClip(c.id, { volume }, `clip-vol-${c.id}`)} />
                        <div className="ed-mark-times">
                          <button className="btn ghost" onClick={() => changeClip(c.id, { a: Math.min(time, duration - 0.1) })} title="Start at the playhead">
                            From {stamp(c.a)}
                          </button>
                          <button className="btn ghost" onClick={() => time > c.a + 0.1 && changeClip(c.id, { len: time - c.a })} title="End at the playhead">
                            To {stamp(c.a + c.len)}
                          </button>
                          <button className="ed-icon" onClick={() => deleteClip(c.id)} aria-label="Remove this sound" title="Remove (Delete key)">
                            <TrashIcon aria-hidden />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              <p className="ed-hint">The preview plays up to 100%; louder volumes and the cleanup are applied when exporting. Extra sound is cut and sped up with the video.</p>
            </>
          )}

          {tool === "frame" && (
            <FramePanel
              style={style}
              setStyle={setStyle}
              wallpapers={wallpapers}
              imageUrl={url}
              onAddPicture={async () => {
                try {
                  const f = await platform.media.pick(take, "image");
                  if (f) await reload();
                  return f?.reference ?? null;
                } catch (e) {
                  setError(`The picture could not be added: ${errorMessage(e)}`);
                  return null;
                }
              }}
              onOpenWallpapers={() => {
                void platform.media.wallpapers().then(setWallpapers, () => undefined);
                if (wallDir) void platform.reveal(wallDir);
              }}
            />
          )}

          {tool === "camera" && <CameraPanel look={camera} hasCamera={!!info.camera} importing={camImport} setCamera={setCamera} onUpload={() => void importCamera()} onRemove={removeCamera} />}
        </div>
      </aside>

      <section className="ed-timeline" aria-label="Timeline">
        <div className="ed-tl-head">
          <span className="ed-player-title">Timeline</span>
          <div className="ed-tl-tools glide">
            <span className="glide-pill" aria-hidden />
            <button className="ed-icon" onClick={undo} disabled={!history.current.back.length} aria-label="Undo" title="Undo (Ctrl+Z)">
              <ArrowUturnLeftIcon aria-hidden />
            </button>
            <button className="ed-icon" onClick={redo} disabled={!history.current.fwd.length} aria-label="Redo" title="Redo (Ctrl+Y)">
              <ArrowUturnRightIcon aria-hidden />
            </button>
            <span className="ed-tl-sep" aria-hidden />
            <button className="btn ghost ed-tool-btn" onClick={splitHere} title="Split the clip at the playhead (S)">
              <ScissorsIcon aria-hidden /> Split
            </button>
            <button className="btn ghost ed-tool-btn" onClick={addManual} title="Add a zoom at the playhead">
              <MagnifyingGlassPlusIcon aria-hidden /> Zoom
            </button>
            <button className="btn ghost ed-tool-btn" onClick={removeSel} disabled={!selPiece && !selZoom && !selManual && !selClip} title="Delete key">
              <TrashIcon aria-hidden /> {selPiece ? (selPieceCut ? "Restore piece" : "Delete piece") : selZoom ? (selZoom.off ? "Turn zoom on" : "Turn zoom off") : selManual ? "Delete zoom" : selClip ? "Remove sound" : "Delete"}
            </button>
          </div>
          <span className="ed-legend">
            <i className="zoom" aria-hidden /> Zoom
          </span>
          <span className="ed-legend">
            <i className="marker" aria-hidden /> Marker
          </span>
          <span className="grow" />
          {!isPlain(segs) && <span className="ed-chip accent">Final length {stamp(kept)}</span>}
          <span className="ed-hint-inline">Click a piece, zoom or sound to select · S splits · Delete removes</span>
        </div>
        <div className="ed-tl-body">
          <div className={hasAudioLane ? "ed-tl-heads with-audio" : "ed-tl-heads"} aria-hidden>
            <span className="ruler" />
            <span>
              <FilmIcon /> Video
            </span>
            <span>
              <MagnifyingGlassPlusIcon /> Zoom
            </span>
            {hasAudioLane && (
              <span>
                <MusicalNoteIcon /> Sound
              </span>
            )}
          </div>
          <div
            className={hasAudioLane ? "ed-lanes with-audio" : "ed-lanes"}
            ref={lanes}
            role="slider"
            tabIndex={0}
            aria-label="Position"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={time}
            aria-valuetext={formatTime(time)}
            onKeyDown={(e) => {
              const d = { ArrowRight: 1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
              if (d !== undefined) (e.preventDefault(), seekTo(time + d));
              if (e.key === " ") (e.preventDefault(), toggle());
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              const hit = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-piece], [data-zoom], [data-manual], [data-audio]") : null;
              if (hit?.dataset.zoom) {
                setSel({ kind: "zoom", i: Number(hit.dataset.zoom) });
                setTool("zoom");
              } else if (hit?.dataset.manual) {
                setSel({ kind: "manual", id: hit.dataset.manual });
                setTool("zoom");
              } else if (hit?.dataset.audio) {
                setSel({ kind: "audio", id: hit.dataset.audio });
                setTool("sound");
              } else if (hit?.dataset.piece) setSel({ kind: "piece", i: Number(hit.dataset.piece) });
              else setSel(null);
              e.currentTarget.setPointerCapture(e.pointerId);
              scrubbing.current = true;
              seekFromPointer(e);
            }}
            onPointerMove={(e) => scrubbing.current && seekFromPointer(e)}
            onPointerUp={() => (scrubbing.current = false)}
          >
            <div className="ed-ruler" aria-hidden>
              {ticks.map((t) => (
                <span key={t} style={{ left: at(t) }}>
                  {formatTime(t)}
                </span>
              ))}
              {data?.markers.map((m) => (
                <i key={m} className="ed-marker" style={{ left: at(m) }} title={`Marker · ${formatTime(m)}`} />
              ))}
            </div>
            <div className="ed-lane clip" aria-hidden>
              {parts.map((p, i) => {
                const cut = isCut(edit.cuts, (p.a + p.b) / 2);
                return (
                  <span key={`${p.a}-${p.b}`} data-piece={i} className={[cut ? "cut" : "", sel?.kind === "piece" && sel.i === i ? "sel" : ""].join(" ").trim()} style={{ left: at(p.a), width: width(p.a, p.b) }}>
                    {cut ? "Removed" : parts.length > 1 ? `Piece ${i + 1}` : info.name}
                  </span>
                );
              })}
            </div>
            <div className="ed-lane zooms" aria-hidden>
              {zoomList.map((r, i) =>
                coveredByHand(r) ? null : (
                  <span key={`${r.start}`} data-zoom={i} className={[r.off || !zl.on ? "off" : "", r.edited ? "edited" : "", sel?.kind === "zoom" && sel.i === i ? "sel" : ""].join(" ").trim()} style={{ left: at(r.start), width: width(r.start, r.end) }}>
                    {r.off || !zl.on ? "Off" : `${r.zoom.toFixed(1)}×`}
                  </span>
                ),
              )}
              {manual.map((m) => (
                <span key={m.id} data-manual={m.id} className={["hand", sel?.kind === "manual" && sel.id === m.id ? "sel" : ""].join(" ").trim()} style={{ left: at(manualRegion(m).start), width: width(m.a, m.b) }} title="Zoom placed by hand">
                  {`${m.zoom.toFixed(1)}×`}
                </span>
              ))}
              {!zoomList.length && !manual.length && <em>No zooms yet · add one at the playhead</em>}
            </div>
            {hasAudioLane && (
              <div className="ed-lane audio" aria-hidden>
                {edit.audio.map((c) => (
                  <span key={c.id} data-audio={c.id} className={sel?.kind === "audio" && sel.id === c.id ? "sel" : ""} style={{ left: at(c.a), width: width(c.a, c.a + c.len) }}>
                    {c.name}
                  </span>
                ))}
              </div>
            )}
            {mergeSpans(edit.cuts, duration).map((c) => (
              <i key={`${c.a}`} className="ed-cutmask" style={{ left: at(c.a), width: at(c.b - c.a) }} aria-hidden />
            ))}
            {edit.speeds.map((x) => (
              <i key={`sp-${x.a}`} className={x.rate < 1 ? "ed-speedmask slow" : "ed-speedmask"} style={{ left: at(x.a), width: at(x.b - x.a) }} aria-hidden>
                <b>{rateLabel(x.rate)}</b>
              </i>
            ))}
            <i className="ed-playhead" style={{ left: at(time) }} aria-hidden />
          </div>
        </div>
      </section>
    </main>
  );
}

/** Ruler labels: a round step that gives at most about ten of them. */
function rulerTicks(duration: number): number[] {
  if (!duration) return [0];
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => duration / s <= 10) ?? 1200;
  const out: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) out.push(t);
  return out;
}
