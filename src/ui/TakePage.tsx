import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { buildExportGraph, RING_TIME } from "../core/exportGraph";
import { DEFAULT_FRAME, FRAME_BACKGROUNDS, frameCss, type ScreenFrame } from "../core/frame";
import { BUBBLE_SPOTS, type BubbleSpot } from "../core/recorder";
import { clickRegions, pointerZooms, regionKeys, viewAt, zoomView, type AfterClick } from "../core/zoom";
import { errorMessage, platform, type TakeInfo } from "../platform";
import { addSplit, editedZooms, editZoom, EMPTY_EDIT, isCut, keptDuration, mergeSpans, pieces, playFrom, togglePiece, validEdit, type TakeEdit } from "../core/edits";
import { DEFAULT_EXPORT, ENCODINGS, exportFps, exportSize, FPS_CHOICES, QUALITIES, savePreset, validExport, validPreset, type EditorPreset, type ExportSettings } from "../core/exportSettings";
import { Dropdown, Segmented, Slider, Swatches, Switch } from "./controls";
import { MOTION, reducedMotion } from "./motion";
import { ArrowDownTrayIcon, ArrowUturnLeftIcon, ArrowUturnRightIcon, BackwardIcon, BookmarkIcon, ChevronDownIcon, CursorArrowRaysIcon, FilmIcon, FlagIcon, FolderOpenIcon, ForwardIcon, InformationCircleIcon, ListBulletIcon, MagnifyingGlassPlusIcon, PauseIcon, PhotoIcon, PlayIcon, ScissorsIcon, TrashIcon, VideoCameraIcon } from "./icons";
import { formatTime } from "./motion";

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** Time with tenths, for the timecode and the lists. */
const stamp = (t: number) => `${formatTime(t)}.${Math.floor((Math.max(0, t) % 1) * 10)}`;
const bytes = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);
type Tool = "zoom" | "clicks" | "frame" | "camera";
type Pane = "details" | "clicks" | "markers";

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

/**
 * The editor for a finished recording, laid out like ReeliF Studio: a rail and side panel
 * (details, clicks, markers), the player (tools, stage, transport), the inspector with tabs, and
 * the timeline across the bottom. Panels are separated by resizable splitters.
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
  const [zoomOn, setZoomOn] = useState(true);
  const [depth, setDepth] = useState(1.8);
  const [hold, setHold] = useState(1.5);
  const [after, setAfter] = useState<AfterClick>("follow");
  const [rings, setRings] = useState(true);
  const [frame, setFrame] = useState<ScreenFrame | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [spot, setSpot] = useState<BubbleSpot>("bottom-right");
  const [camSize, setCamSize] = useState(0.22);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [exporting, setExporting] = useState<number | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);
  const cam = useRef<HTMLVideoElement | null>(null);
  const picture = useRef<HTMLVideoElement | null>(null);
  const [tool, setTool] = useState<Tool>("zoom");
  // Cuts and per-zoom changes, with undo; saved into take.json shortly after each change.
  const [edit, setEditState] = useState<TakeEdit>(EMPTY_EDIT);
  const [sel, setSel] = useState<{ kind: "piece" | "zoom"; i: number } | null>(null);
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
  // Export choices and saved looks, remembered on this computer.
  const [exp, setExp] = useState<ExportSettings>(() => load(EXPORT_KEY, validExport, DEFAULT_EXPORT));
  const [presets, setPresets] = useState<EditorPreset[]>(() => load(PRESETS_KEY, readPresets, []));
  const [presetName, setPresetName] = useState("");
  useEffect(() => store(EXPORT_KEY, exp), [exp]);
  useEffect(() => store(PRESETS_KEY, presets), [presets]);
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const canvas = useRef<HTMLDivElement | null>(null);
  const lanes = useRef<HTMLDivElement | null>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    platform
      .takeGet(take)
      .then((t) => {
        setInfo(t);
        const d = t.data;
        if (d) {
          setZoomOn(d.zoom.on);
          setDepth(d.zoom.depth);
          setHold(d.zoom.hold);
          setAfter(d.zoom.after);
          setRings(d.ripples);
          if (d.camera) {
            setSpot(d.camera.spot);
            setCamSize(d.camera.size);
          }
          setEditState(validEdit(d.edit));
        }
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [take]);

  const data = info?.data ?? null;
  // The video's own length, once known: older takes saved a clock time a little past the picture.
  const [videoLen, setVideoLen] = useState<number | null>(null);
  const duration = videoLen && data ? Math.min(data.duration, videoLen) : (data?.duration ?? 0);
  // Click zooms from the recording, then the changes made to single zooms.
  const regions = useMemo(() => {
    if (!data || !data.clicks.length) return [];
    const opts = { zoom: depth, hold, after };
    return data.path.length ? pointerZooms(data.clicks, data.path, duration, opts) : clickRegions(data.clicks, duration, opts);
  }, [data, depth, hold, after, duration]);
  const zoomList = useMemo(() => editedZooms(regions, edit.zooms), [regions, edit.zooms]);
  const keys = useMemo(() => (zoomOn ? regionKeys(zoomList.filter((r) => !r.off)) : []), [zoomOn, zoomList]);
  const cutsRef = useRef(edit.cuts);
  cutsRef.current = edit.cuts;
  const kept = keptDuration(duration, edit.cuts);

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

  // The preview follows the video frame by frame (the same curve as the export).
  useEffect(() => {
    let raf = 0;
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
        setTime(t);
        const z = viewAt(keys, t);
        if (picture.current) picture.current.style.transform = `scale(${z.z}) translate(${-zoomView(z.fx, z.z) * 100}%, ${-zoomView(z.fy, z.z) * 100}%)`;
        const c = cam.current;
        if (c && Math.abs(c.currentTime - t) > 0.15) c.currentTime = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [keys, duration]);

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
    if (!rings || !data) return [];
    return data.clicks
      .filter((c) => time >= c.t && time < c.t + RING_TIME)
      .map((c) => {
        const v = viewAt(keys, c.t);
        return { x: (c.x - zoomView(v.fx, v.z)) * v.z, y: (c.y - zoomView(v.fy, v.z)) * v.z, k: c.t };
      });
  }, [rings, data, time, keys]);

  const currentLook = (name: string): EditorPreset => ({ name, zoom: { on: zoomOn, depth, hold, after }, rings, frame, camera: { on: camOn, spot, size: camSize }, export: exp });
  const applyLook = (p: EditorPreset) => {
    setZoomOn(p.zoom.on);
    setDepth(p.zoom.depth);
    setHold(p.zoom.hold);
    setAfter(p.zoom.after);
    setRings(p.rings);
    setFrame(p.frame);
    setCamOn(p.camera.on);
    setSpot(p.camera.spot);
    setCamSize(p.camera.size);
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
    setExported(null);
    setExporting(0);
    const useCam = camOn && !!info.camera;
    const size = exportSize(data.width, data.height, exp.quality);
    const fps = exportFps(exp, data.fps);
    const graph = buildExportGraph({ ...size, fps, keys, rings: rings ? data.clicks : [], frame, camera: useCam ? { spot, size: camSize } : null, gif: exp.format === "gif", cuts: edit.cuts, duration, audio: info.audio === true });
    try {
      const job = platform.takeExport(take, graph, useCam, kept, fps, exp.format, exp.encoding);
      const off = await job.onProgress((p) => p >= 0 && setExporting(p));
      const out = await job.promise.finally(off);
      setExported(out);
      setInfo(await platform.takeGet(take));
    } catch (e) {
      setError(`The export failed: ${errorMessage(e)}`);
    } finally {
      setExporting(null);
    }
  };

  // The picture is as large as the canvas allows while keeping the recording's shape.
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
    const clean = { ...(next.zoom !== undefined && Math.abs(next.zoom - depth) > 1e-6 ? { zoom: next.zoom } : {}), ...(next.off ? { off: true } : {}) };
    setEdit(editZoom(editRef.current, z, Object.keys(clean).length ? clean : null), key);
  };
  /** Delete key: removes (or brings back) the selected piece, or turns the selected zoom off/on. */
  const removeSel = () => {
    if (sel?.kind === "piece") {
      const p = pieces(duration, editRef.current.splits)[sel.i];
      if (p) setEdit(togglePiece(editRef.current, p, duration));
    } else if (sel?.kind === "zoom") {
      const z = zoomList[sel.i];
      if (z) zoomChange(z, { off: !z.off });
    }
  };
  const keyState = useRef({ toggle, seekTo, time, splitHere, removeSel, undo, redo, clear: () => setSel(null) });
  keyState.current = { toggle, seekTo, time, splitHere, removeSel, undo, redo, clear: () => setSel(null) };
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
  useEffect(() => {
    try {
      localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    } catch {
      /* not remembered */
    }
  }, [sizes]);
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
  const ar = data ? data.width / data.height : 16 / 9;
  // The stage is a size container, so its shorter side is a CSS length (container units).
  const fcss = frame ? frameCss(frame, `${100 * Math.min(1, 1 / ar)}cqi`) : null;
  const stageW = room.w && room.h ? Math.min(room.w, room.h * ar) : 0;
  const zooms = zoomOn ? zoomList.filter((r) => !r.off) : [];
  const parts = pieces(duration, edit.splits);
  const selPiece = sel?.kind === "piece" ? parts[sel.i] : undefined;
  const selZoom = sel?.kind === "zoom" ? zoomList[sel.i] : undefined;
  const selPieceCut = selPiece ? isCut(edit.cuts, (selPiece.a + selPiece.b) / 2) : false;
  const at = (t: number) => `${(t / (duration || 1)) * 100}%`;
  const ticks = rulerTicks(duration);
  const zoomNow = viewAt(keys, time).z;
  const panes: ReadonlyArray<{ id: Pane; icon: typeof PhotoIcon; label: string }> = [
    { id: "details", icon: InformationCircleIcon, label: "Details" },
    { id: "clicks", icon: ListBulletIcon, label: "Clicks" },
    { id: "markers", icon: FlagIcon, label: "Markers" },
  ];
  const tabs: ReadonlyArray<{ id: Tool; icon: typeof PhotoIcon; label: string }> = [
    { id: "zoom", icon: MagnifyingGlassPlusIcon, label: "Zoom" },
    { id: "clicks", icon: CursorArrowRaysIcon, label: "Cursor" },
    { id: "frame", icon: PhotoIcon, label: "Frame" },
    ...(info.camera ? [{ id: "camera" as const, icon: VideoCameraIcon, label: "Camera" }] : []),
  ];
  const created = data?.createdAt ? new Date(data.createdAt) : null;

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
                <dd>{edit.cuts.length ? `${formatTime(kept)} of ${formatTime(duration)}` : formatTime(duration)}</dd>
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
                <dd>{data?.source === "window" ? "Window" : "Screen"}</dd>
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
      </aside>

      <section className="ed-player">
        <header className="ed-player-head">
          <span className="ed-player-title">Preview</span>
          <span className="ed-chip">{data ? `${data.width}×${data.height}` : "—"}</span>
          {zoomOn && zooms.length > 0 && <span className="ed-chip accent">{zooms.length} zooms</span>}
          <span className="grow" />
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
                              {p.zoom.on ? `Zoom ${p.zoom.depth.toFixed(1)}×` : "No zoom"} · {p.frame ? "Frame" : "No frame"} · {p.export.format.toUpperCase()} {QUALITIES.find((q) => q.id === p.export.quality)?.label}
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
                  <p className="ui-pop-empty">No presets yet. Save the zoom, cursor, frame, camera and export choices under a name.</p>
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
                <span className="ui-pop-label">Quality</span>
                <Segmented wide label="Quality" value={exp.quality} onChange={(quality) => setExp((s) => ({ ...s, quality }))} options={QUALITIES.map((q) => {
                  const z = data ? exportSize(data.width, data.height, q.id) : null;
                  return { value: q.id, label: q.label, sub: z ? `${z.width}×${z.height}` : "" };
                })} />
                {exp.format === "mp4" && (
                  <>
                    <span className="ui-pop-label">Encoding</span>
                    <Segmented wide label="Encoding" value={exp.encoding} onChange={(encoding) => setExp((s) => ({ ...s, encoding }))} options={ENCODINGS.map((e) => ({ value: e.id, label: e.label }))} />
                  </>
                )}
                <span className="ui-pop-label">Frame rate</span>
                <Segmented wide label="Frame rate" value={exp.fps} onChange={(fps) => setExp((s) => ({ ...s, fps }))} options={FPS_CHOICES[exp.format].map((f) => ({ value: f, label: data && f > data.fps ? `${f} · ${data.fps} max` : `${f} fps` }))} />
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
        </header>

        <div className="ed-stage" ref={canvas}>
          {stageW > 0 && (
            <div className="take-stage" style={{ width: stageW, aspectRatio: String(ar), containerType: "inline-size", ...(fcss ? fcss.stage : {}) }}>
              <div className="take-picture" style={fcss ? { position: "absolute", ...fcss.picture } : undefined}>
                <video ref={(el) => void ((video.current = el), (picture.current = el))} src={info.video ? platform.mediaUrl(info.video) : undefined} onLoadedMetadata={(e) => setVideoLen(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)} onEnded={() => setPlaying(false)} onClick={toggle} preload="auto" />
                {ringNow.map((r) => (
                  <i key={r.k} className="take-ring" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }} />
                ))}
              </div>
              {info.camera && camOn && (
                <span className={`take-cam ${spot}`} style={{ width: `${camSize * 100}%` }}>
                  <video ref={cam} src={platform.mediaUrl(info.camera)} muted preload="auto" />
                </span>
              )}
            </div>
          )}
          {(error || exported) && (
            <p className={error ? "ed-note error" : "ed-note"} role={error ? "alert" : "status"}>
              {error ?? `Exported and checked: ${exported?.split(/[\\/]/).pop()}`}
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
            <button key={t.id} role="tab" aria-selected={tool === t.id} className={tool === t.id ? "ed-tab on" : "ed-tab"} onClick={() => setTool(t.id)}>
              <t.icon aria-hidden />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <div className="ed-panel" role="tabpanel" key={tool}>
          {tool === "zoom" && (
            <>
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
                    {!selZoom.off && <Slider label="Zoom" value={selZoom.zoom} min={1.2} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => zoomChange(selZoom, { zoom: v }, `zoom-${sel?.i}`)} />}
                  </div>
                </>
              )}
              <div className="ed-section-head">
                <span>All zooms</span>
                <button className="ed-reset" onClick={() => (setDepth(1.8), setHold(1.5), setAfter("follow"), setZoomOn(true))}>
                  Reset
                </button>
              </div>
              <div className="ed-card">
                <div className="ed-line">
                  <span>
                    <strong>Zoom on clicks</strong>
                    <em>{data?.clicks.length ? `${zooms.length} zoom${zooms.length === 1 ? "" : "s"}` : "No clicks in this recording"}</em>
                  </span>
                  <Switch on={zoomOn} label="Zoom on clicks" onChange={setZoomOn} />
                </div>
              </div>
              {zoomOn && (
                <div className="ed-card">
                  <Slider label="Depth" value={depth} min={1.2} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={setDepth} />
                  <Slider label="Hold" value={hold} min={0.5} max={4} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={setHold} />
                  <div className="ed-field">
                    <span>When the mouse moves on</span>
                    <Segmented wide label="When the mouse moves on" value={after} onChange={setAfter} options={[{ value: "follow", label: "Follow" }, { value: "zoomOut", label: "Zoom out" }]} />
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
                    <em>{rings ? "A ring where you click" : "Off"}</em>
                  </span>
                  <Switch on={rings} label="Click rings" onChange={setRings} />
                </div>
              </div>
              <p className="ed-hint">{data?.clicks.length ?? 0} clicks were recorded. Rings and zooms follow them.</p>
            </>
          )}

          {tool === "frame" && (
            <>
              <div className="ed-section-head">
                <span>Background and frame</span>
                {frame && (
                  <button className="ed-reset" onClick={() => setFrame(DEFAULT_FRAME)}>
                    Reset
                  </button>
                )}
              </div>
              <div className="ed-card">
                <div className="ed-line">
                  <span>
                    <strong>Background and frame</strong>
                    <em>{frame ? "Space, rounded corners, shadow" : "Off · the recording fills the video"}</em>
                  </span>
                  <Switch on={!!frame} label="Background and frame" onChange={(v) => setFrame(v ? DEFAULT_FRAME : null)} />
                </div>
              </div>
              {frame && (
                <>
                  <div className="ed-card">
                    <span className="ed-label">Background</span>
                    <Swatches label="Background" value={frame.background} onChange={(id) => setFrame({ ...frame, background: id })} options={FRAME_BACKGROUNDS.map((b) => ({ id: b.id, label: b.label, paint: b.from === b.to ? b.from : `linear-gradient(135deg, ${b.from}, ${b.to})` }))} />
                  </div>
                  <div className="ed-card">
                    <Slider label="Space" value={frame.padding} min={0} max={0.2} step={0.005} format={pct} onChange={(v) => setFrame({ ...frame, padding: v })} />
                    <Slider label="Corners" value={frame.radius} min={0} max={0.1} step={0.0025} format={(v) => pct(v * 10)} onChange={(v) => setFrame({ ...frame, radius: v })} />
                    <Slider label="Shadow" value={frame.shadow} min={0} max={1} step={0.05} format={pct} onChange={(v) => setFrame({ ...frame, shadow: v })} />
                  </div>
                </>
              )}
            </>
          )}

          {tool === "camera" && info.camera && (
            <>
              <div className="ed-section-head">
                <span>Camera bubble</span>
              </div>
              <div className="ed-card">
                <div className="ed-line">
                  <span>
                    <strong>Camera bubble</strong>
                    <em>{camOn ? BUBBLE_SPOTS.find((s) => s.id === spot)?.label : "Hidden"}</em>
                  </span>
                  <Switch on={camOn} label="Camera bubble" onChange={setCamOn} />
                </div>
              </div>
              {camOn && (
                <div className="ed-card">
                  <div className="ed-field">
                    <span>Corner</span>
                    <div className="ed-corners" role="radiogroup" aria-label="Camera corner">
                      {BUBBLE_SPOTS.map((s) => (
                        <button key={s.id} role="radio" aria-checked={spot === s.id} aria-label={s.label} title={s.label} className={spot === s.id ? `ed-corner ${s.id} on` : `ed-corner ${s.id}`} onClick={() => setSpot(s.id)}>
                          <i aria-hidden />
                        </button>
                      ))}
                    </div>
                  </div>
                  <Slider label="Size" value={camSize} min={0.12} max={0.4} step={0.01} format={pct} onChange={setCamSize} />
                </div>
              )}
            </>
          )}
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
            <button className="btn ghost ed-tool-btn" onClick={removeSel} disabled={!selPiece && !selZoom} title="Delete key">
              <TrashIcon aria-hidden /> {selPiece ? (selPieceCut ? "Restore piece" : "Delete piece") : selZoom ? (selZoom.off ? "Turn zoom on" : "Turn zoom off") : "Delete"}
            </button>
          </div>
          <span className="ed-legend">
            <i className="zoom" aria-hidden /> Zoom
          </span>
          <span className="ed-legend">
            <i className="marker" aria-hidden /> Marker
          </span>
          <span className="grow" />
          {edit.cuts.length > 0 && <span className="ed-chip accent">After cuts {stamp(kept)}</span>}
          <span className="ed-hint-inline">Click a piece or a zoom to select · S splits · Delete removes</span>
        </div>
        <div className="ed-tl-body">
          <div className="ed-tl-heads" aria-hidden>
            <span className="ruler" />
            <span>
              <FilmIcon /> Video
            </span>
            <span>
              <MagnifyingGlassPlusIcon /> Zoom
            </span>
          </div>
          <div
            className="ed-lanes"
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
              const hit = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-piece], [data-zoom]") : null;
              if (hit?.dataset.zoom) {
                setSel({ kind: "zoom", i: Number(hit.dataset.zoom) });
                setTool("zoom");
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
                  <span key={`${p.a}-${p.b}`} data-piece={i} className={[cut ? "cut" : "", sel?.kind === "piece" && sel.i === i ? "sel" : ""].join(" ").trim()} style={{ left: at(p.a), width: `calc(${((p.b - p.a) / (duration || 1)) * 100}% - 2px)` }}>
                    {cut ? "Removed" : parts.length > 1 ? `Piece ${i + 1}` : info.name}
                  </span>
                );
              })}
            </div>
            <div className={zoomOn ? "ed-lane zooms" : "ed-lane zooms disabled"} aria-hidden>
              {zoomList.map((r, i) => (
                <span key={`${r.start}`} data-zoom={i} className={[r.off ? "off" : "", r.edited ? "edited" : "", sel?.kind === "zoom" && sel.i === i ? "sel" : ""].join(" ").trim()} style={{ left: at(r.start), width: `calc(${((r.end - r.start) / (duration || 1)) * 100}% - 2px)` }}>
                  {r.off ? "Off" : `${r.zoom.toFixed(1)}×`}
                </span>
              ))}
              {!zoomList.length && <em>No clicks to zoom on</em>}
            </div>
            {mergeSpans(edit.cuts, duration).map((c) => (
              <i key={`${c.a}`} className="ed-cutmask" style={{ left: at(c.a), width: at(c.b - c.a) }} aria-hidden />
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

