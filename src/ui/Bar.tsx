import { gsap } from "gsap";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { BUBBLE_SPOTS, onRecording, recordingType, type BubbleSpot, type MonitorRect } from "../core/recorder";
import type { AfterClick } from "../core/zoom";
import { errorMessage, platform, type CaptureTargets, type ScreenArea, type TakeData } from "../platform";
import {
  ArrowPathIcon,
  CheckIcon,
  ChevronUpIcon,
  ClockIcon,
  ComputerDesktopIcon,
  EllipsisVerticalIcon,
  FlagIcon,
  FolderOpenIcon,
  MicrophoneIcon,
  MinusIcon,
  PauseIcon,
  PlayIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  StopIcon,
  VideoCameraIcon,
  VideoCameraSlashIcon,
  WindowIcon,
  XMarkIcon,
} from "./icons";
import { Segmented, Slider, Switch } from "./controls";
import { formatTime, MOTION, reducedMotion } from "./motion";

const now = () => performance.now();
type Phase = "idle" | "countdown" | "recording" | "saving";
type Panel = "source" | "mic" | "camera" | "more" | null;

/** Choices remembered on this computer (defaults when storage is unavailable). */
interface Prefs {
  surface: "monitor" | "window";
  systemAudio: boolean;
  mic: string;
  cam: string;
  spot: BubbleSpot;
  camSize: "small" | "medium" | "large";
  clickZoom: boolean;
  zoomDepth: number;
  zoomHold: number;
  after: AfterClick;
  ripples: boolean;
  cursor: boolean;
  fps: 30 | 60;
  countdown: 0 | 3 | 5;
  limit: 0 | 1 | 5 | 10 | 30;
  noise: boolean;
  scriptOn: boolean;
  speed: number;
}
const PREFS_KEY = "reelifcapture.prefs";
const DEFAULT_PREFS: Prefs = { surface: "monitor", systemAudio: true, mic: "", cam: "", spot: "bottom-right", camSize: "medium", clickZoom: true, zoomDepth: 1.8, zoomHold: 1.5, after: "follow", ripples: true, cursor: true, fps: 60, countdown: 3, limit: 0, noise: true, scriptOn: false, speed: 1 };
const BUBBLE_SIZE = { small: 0.17, medium: 0.22, large: 0.3 } as const;
const NEXT_COUNTDOWN = { 0: 3, 3: 5, 5: 0 } as const;
const MIN_FREE = 1.5e9;
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** One MediaRecorder streaming its chunks, in order, into a raw file. */
function sink(stream: MediaStream, path: string, mime: string) {
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  let chain = Promise.resolve();
  let failed: unknown = null;
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    chain = chain.then(async () => {
      if (!failed) await platform.rawAppend(path, new Uint8Array(await e.data.arrayBuffer())).catch((err: unknown) => void (failed = err));
    });
  };
  const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
  return {
    rec,
    finish: async () => {
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      await chain;
      if (failed) throw failed;
    },
  };
}
type Sink = ReturnType<typeof sink>;
const stopStream = (s: MediaStream | null | undefined) => s?.getTracks().forEach((t) => t.stop());

/** A choice in a panel list: icon, name, note, and a check when chosen. */
function Choice({ icon, title, note, on, onPick }: { icon: ReactNode; title: string; note?: string; on: boolean; onPick: () => void }) {
  return (
    <button role="radio" aria-checked={on} className={on ? "cb-choice on" : "cb-choice"} onClick={onPick}>
      <span className="cb-choice-icon" aria-hidden>
        {icon}
      </span>
      <span className="cb-choice-text">
        <strong>{title}</strong>
        {note && <em>{note}</em>}
      </span>
      {on && <CheckIcon className="cb-check" aria-hidden />}
    </button>
  );
}

function Setting({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="cb-setting">
      <span>
        <strong>{title}</strong>
        {note && <em>{note}</em>}
      </span>
      {children}
    </div>
  );
}

interface Run {
  streams: MediaStream[];
  micStream: MediaStream | null;
  camStream: MediaStream | null;
  sinks: Array<{ kind: "mic" | "camera"; path: string; sink: Sink }>;
  take: string;
  rect: MonitorRect | null;
  t0: number;
  pausedAt: number | null;
  pausedTotal: number;
  pauses: Array<{ a: number; b: number }>;
  markers: number[];
}

type Step = "save" | "video" | "camera" | "finish";
const STEP_LABEL: Record<Step, string> = { save: "Saving the recording", video: "Making the video", camera: "Adding the camera", finish: "Saving clicks and settings" };

/**
 * The capture bar: a small window at the bottom of the screen, always on top and left out of the
 * recording. Choose what to record, count down over the screen, record with the controls here,
 * then the editor opens on the finished take.
 */
export default function Bar() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const set = (c: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...c }));
  const { surface, systemAudio, mic, cam, spot, camSize, clickZoom, zoomDepth, zoomHold, after, ripples, cursor, fps, countdown, limit, noise, scriptOn, speed } = prefs;
  const [phase, setPhase] = useState<Phase>("idle");
  const [panel, setPanel] = useState<Panel>(null);
  const [moreTab, setMoreTab] = useState<"recording" | "effects" | "script">("recording");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [targets, setTargets] = useState<CaptureTargets | null>(null);
  const [monitorIdx, setMonitorIdx] = useState(0);
  const [windowId, setWindowId] = useState("");
  const [script, setScript] = useState("");
  const [count, setCount] = useState(3);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [markers, setMarkers] = useState(0);
  const [step, setStep] = useState<Step>("save");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shell = useRef<HTMLDivElement | null>(null);
  const bar = useRef<HTMLDivElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);
  const run = useRef<Run | null>(null);
  const prompter = useRef<HTMLDivElement | null>(null);
  const camVideo = useRef<HTMLVideoElement | null>(null);
  const meter = useRef<HTMLSpanElement | null>(null);
  const cancelled = useRef(false);
  const lifted = useRef(false);
  const settleTimer = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* not remembered */
    }
  }, [prefs]);

  // The window is exactly as big as the bar plus whatever is open above it.
  useLayoutEffect(() => {
    const el = shell.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      void platform.bar.fit(Math.ceil(r.width), Math.ceil(r.height)).catch(() => undefined);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, []);

  // The bar rises in once; each phase's contents and each panel enter with a short rise.
  useLayoutEffect(() => {
    if (!bar.current || reducedMotion()) return;
    gsap.fromTo(bar.current, { y: 24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: MOTION.base, ease: MOTION.ease, clearProps: "transform,opacity,visibility" });
  }, []);
  useLayoutEffect(() => {
    if (!bar.current || reducedMotion()) return;
    gsap.fromTo(bar.current.querySelectorAll(":scope > :not(.glide-pill)"), { y: 6, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: MOTION.fast + 0.1, ease: MOTION.ease, stagger: 0.015, clearProps: "transform,opacity,visibility" });
  }, [phase]);
  const cardKey = error ? "error" : (panel ?? (phase === "recording" && scriptOn && script ? "prompter" : null));
  useLayoutEffect(() => {
    if (!card.current || reducedMotion()) return;
    gsap.fromTo(card.current, { y: 10, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: MOTION.fast + 0.08, ease: MOTION.ease, clearProps: "transform,opacity,visibility" });
  }, [cardKey]);

  // Moving the bar: it scales out a little while it travels and springs back when let go.
  // The OS runs the drag, so "let go" is when the moves stop (or the press ends without one).
  const settle = () => {
    window.clearTimeout(settleTimer.current);
    if (!lifted.current) return;
    lifted.current = false;
    shell.current?.classList.remove("moving");
    if (reducedMotion()) return;
    gsap.to([bar.current, card.current].filter(Boolean), { scale: 1, duration: 0.42, ease: "back.out(2.2)", overwrite: "auto" });
  };
  const lift = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setPanel(null);
    lifted.current = true;
    shell.current?.classList.add("moving");
    if (!reducedMotion()) gsap.to([bar.current, card.current].filter(Boolean), { scale: 0.94, duration: 0.2, ease: "power3.out", overwrite: "auto" });
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(settle, 600);
    void platform.bar.drag().catch(settle);
  };
  useEffect(() => {
    let off: (() => void) | null = null;
    void platform.bar
      .onMoved(() => {
        if (!lifted.current) return;
        window.clearTimeout(settleTimer.current);
        settleTimer.current = window.setTimeout(settle, 260);
      })
      .then((u) => (off = u));
    window.addEventListener("pointerup", settle);
    return () => {
      off?.();
      window.removeEventListener("pointerup", settle);
      window.clearTimeout(settleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A panel closes on Escape and when the bar loses focus.
  useEffect(() => {
    if (!panel) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPanel(null);
    window.addEventListener("keydown", key);
    let off: (() => void) | null = null;
    void platform.bar.onBlur(() => setPanel(null)).then((u) => (off = u));
    return () => {
      window.removeEventListener("keydown", key);
      off?.();
    };
  }, [panel]);

  const listDevices = () =>
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => {
        setMics(d.filter((x) => x.kind === "audioinput" && x.deviceId));
        setCams(d.filter((x) => x.kind === "videoinput" && x.deviceId));
      })
      .catch(() => undefined);

  const loadTargets = () =>
    void platform
      .captureTargets()
      .then((t) => {
        setTargets(t);
        setMonitorIdx((i) => (t.monitors.some((m) => m.index === i) ? i : (t.monitors.find((m) => m.primary)?.index ?? 0)));
        setWindowId((w) => (t.windows.some((x) => x.id === w) ? w : (t.windows[0]?.id ?? "")));
      })
      .catch(() => undefined);

  const stopAll = () => run.current?.streams.forEach(stopStream);

  useEffect(() => {
    void listDevices();
    loadTargets();
    return () => {
      void platform.overlay.close().catch(() => undefined);
      if (run.current) void platform.captureCancel().catch(() => undefined);
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live camera preview while its panel is open.
  useEffect(() => {
    if (panel !== "camera" || !cam) return;
    let stream: MediaStream | null = null;
    let live = true;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: { exact: cam }, width: 640, height: 360 } })
      .then((s) => {
        if (!live) return stopStream(s);
        stream = s;
        if (camVideo.current) camVideo.current.srcObject = s;
        void listDevices();
      })
      .catch((e: unknown) => setError(`The camera could not be opened: ${errorMessage(e)}`));
    return () => {
      live = false;
      stopStream(stream);
    };
  }, [panel, cam]);

  // Live microphone level while its panel is open.
  useEffect(() => {
    if (panel !== "mic" || !mic) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let live = true;
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: { exact: mic } } })
      .then((s) => {
        if (!live) return stopStream(s);
        stream = s;
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          an.getFloatTimeDomainData(buf);
          const rms = Math.sqrt(buf.reduce((sum, v) => sum + v * v, 0) / buf.length);
          meter.current?.style.setProperty("--level", String(Math.min(1, rms * 4)));
          raf = requestAnimationFrame(tick);
        };
        tick();
        void listDevices();
      })
      .catch((e: unknown) => setError(`The microphone could not be opened: ${errorMessage(e)}`));
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      stopStream(stream);
      void ctx?.close().catch(() => undefined);
    };
  }, [panel, mic]);

  const seconds = () => {
    const r = run.current;
    return r ? (now() - r.t0 - r.pausedTotal - (r.pausedAt ? now() - r.pausedAt : 0)) / 1000 : 0;
  };

  const [overLimit, setOverLimit] = useState(false);
  // Timer, teleprompter scroll and "Stop after" while recording.
  useEffect(() => {
    if (phase !== "recording") return;
    let raf = 0;
    let last = now();
    const tick = (t: number) => {
      setElapsed(seconds());
      if (limit && seconds() >= limit * 60) setOverLimit(true);
      if (!run.current?.pausedAt && prompter.current) prompter.current.scrollTop += ((t - last) / 1000) * 30 * speed;
      last = t;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // The timer also runs when the bar is minimized (no animation frames then).
    const id = window.setInterval(() => limit && seconds() >= limit * 60 && setOverLimit(true), 500);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, speed]);

  const makeSinks = async (r: Run) => {
    r.sinks = [];
    if (r.micStream) {
      const path = await platform.rawStart("mic");
      r.sinks.push({ kind: "mic", path, sink: sink(r.micStream, path, "audio/webm;codecs=opus") });
    }
    if (r.camStream) {
      const path = await platform.rawStart("camera");
      r.sinks.push({ kind: "camera", path, sink: sink(r.camStream, path, recordingType((t) => MediaRecorder.isTypeSupported(t)) ?? "video/webm") });
    }
  };

  /** The screen the overlay covers first: the chosen display, or the main one for a window. */
  const countdownArea = (): ScreenArea | null => {
    const list = targets?.monitors ?? [];
    const m = (surface === "monitor" ? list.find((x) => x.index === monitorIdx) : undefined) ?? list.find((x) => x.primary) ?? list[0];
    return m ? { x: m.x, y: m.y, width: m.width, height: m.height } : null;
  };

  /** The frame goes up over the screen, the countdown runs in it, then everything starts (also
   *  used by Restart). The frame stays while recording and is never recorded itself. */
  const begin = async (r: Run) => {
    setPhase("countdown");
    cancelled.current = false;
    const area = countdownArea();
    const ready = platform.overlay.ready(1500);
    // null: no overlay; false: shown but Windows would record it, so no frame is drawn.
    const safe = area ? await platform.overlay.open(area).catch(() => null) : null;
    if (safe !== null) {
      await ready;
      platform.overlay.frame(safe);
    }
    for (let n = countdown; n > 0; n--) {
      setCount(n);
      platform.overlay.tick(n);
      await new Promise((res) => setTimeout(res, 1000));
      if (cancelled.current) throw new DOMException("Cancelled", "AbortError");
    }
    platform.overlay.tick(0);
    Object.assign(r, { t0: now(), pausedAt: null, pausedTotal: 0, pauses: [], markers: [] });
    setPaused(false);
    setElapsed(0);
    setMarkers(0);
    setOverLimit(false);
    r.sinks.forEach((x) => x.sink.rec.start(1000));
    r.rect = await platform.captureStart({ kind: surface, monitor: monitorIdx, window: windowId, fps, cursor, systemAudio });
    if (surface === "window" && r.rect) void platform.overlay.move(r.rect).catch(() => undefined);
    if (clickZoom || ripples) await platform.clickLogStart().catch(() => undefined);
    setPhase("recording");
  };

  const fail = (e: unknown) => {
    void platform.overlay.close().catch(() => undefined);
    void platform.captureCancel().catch(() => undefined);
    stopAll();
    run.current = null;
    setPhase("idle");
    if (!(e instanceof DOMException && e.name === "AbortError")) setError(errorMessage(e));
  };

  const start = async () => {
    setError(null);
    setPanel(null);
    if (surface === "window" && !windowId) return setError("Choose the window to record.");
    const free = await platform.freeSpace().catch(() => Number.POSITIVE_INFINITY);
    if (free < MIN_FREE) return setError(`Only ${(free / 1e9).toFixed(1)} GB is free in your Videos folder. Free at least 1.5 GB and try again.`);
    const r: Run = { streams: [], micStream: null, camStream: null, sinks: [], take: "", rect: null, t0: 0, pausedAt: null, pausedTotal: 0, pauses: [], markers: [] };
    run.current = r;
    void platform.editor.minimize().catch(() => undefined);
    try {
      r.micStream = mic ? await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: mic }, echoCancellation: true, noiseSuppression: noise, autoGainControl: noise } }) : null;
      r.camStream = cam ? await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam }, width: 1280, height: 720, frameRate: 30 } }) : null;
      r.streams = [r.micStream, r.camStream].filter((s): s is MediaStream => !!s);
      const d = new Date();
      const p2 = (v: number) => String(v).padStart(2, "0");
      r.take = await platform.takeCreate(`Recording ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`);
      await makeSinks(r);
      await begin(r);
    } catch (e) {
      if (r.take) void platform.takeDelete(r.take).catch(() => undefined);
      fail(e);
    }
  };

  const togglePause = () => {
    const r = run.current;
    if (!r) return;
    if (r.pausedAt) {
      r.pauses.push({ a: r.pausedAt - r.t0, b: now() - r.t0 });
      r.pausedTotal += now() - r.pausedAt;
      r.pausedAt = null;
      r.sinks.forEach((x) => x.sink.rec.resume());
      void platform.capturePause(false).catch((e: unknown) => setError(errorMessage(e)));
      platform.overlay.paused(false);
      setPaused(false);
    } else {
      r.pausedAt = now();
      r.sinks.forEach((x) => x.sink.rec.pause());
      void platform.capturePause(true).catch(() => undefined);
      platform.overlay.paused(true);
      setPaused(true);
    }
  };

  const addMarker = () => {
    const r = run.current;
    if (!r) return;
    r.markers.push(seconds());
    setMarkers(r.markers.length);
  };

  const restart = async () => {
    const r = run.current;
    if (!r) return;
    await platform.clickLogStop().catch(() => null);
    await platform.captureCancel().catch(() => undefined);
    await Promise.all(r.sinks.map((x) => x.sink.finish().catch(() => undefined).then(() => platform.rawDiscard(x.path).catch(() => undefined))));
    try {
      await makeSinks(r);
      await begin(r);
    } catch (e) {
      fail(e);
    }
  };

  const stop = async () => {
    const r = run.current;
    if (!r || phase === "saving") return;
    setPhase("saving");
    setStep("save");
    setProgress(null);
    const length = seconds();
    if (r.pausedAt) r.pauses.push({ a: r.pausedAt - r.t0, b: now() - r.t0 });
    void platform.overlay.close().catch(() => undefined);
    void platform.bar.show().catch(() => undefined);
    try {
      const log = clickZoom || ripples ? await platform.clickLogStop().catch(() => null) : null;
      await Promise.all(r.sinks.map((x) => x.sink.finish()));
      stopAll();
      const micRaw = r.sinks.find((x) => x.kind === "mic")?.path ?? null;
      const camRaw = r.sinks.find((x) => x.kind === "camera")?.path ?? null;
      setStep("video");
      const job = platform.captureFinish(micRaw, r.take, length);
      const off = await job.onProgress((p) => setProgress(p));
      await job.promise.finally(off);
      if (camRaw) {
        setStep("camera");
        setProgress(null);
        const cj = platform.cameraFinish(camRaw, r.take, length);
        const off2 = await cj.onProgress((p) => setProgress(p));
        await cj.promise.finally(off2);
      }
      setStep("finish");
      setProgress(null);
      const area = r.rect ?? { x: 0, y: 0, width: 1920, height: 1080 };
      const data: TakeData = {
        version: 1,
        createdAt: new Date().toISOString(),
        duration: length,
        width: area.width,
        height: area.height,
        fps,
        source: surface,
        clicks: log ? onRecording(log.clicks, area, r.pauses) : [],
        path: log ? onRecording(log.moves, area, r.pauses) : [],
        markers: r.markers,
        zoom: { on: clickZoom, depth: zoomDepth, hold: zoomHold, after },
        ripples,
        camera: camRaw ? { spot, size: BUBBLE_SIZE[camSize] } : null,
      };
      await platform.takeSave(r.take, data);
      run.current = null;
      await platform.editor.open(r.take);
      setPhase("idle");
    } catch (e) {
      stopAll();
      run.current = null;
      setPhase("idle");
      setError(`The recording could not be saved: ${errorMessage(e)}`);
    }
  };

  useEffect(() => {
    if (overLimit && phase === "recording") void stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overLimit, phase]);

  const toggle = (p: Exclude<Panel, null>) => {
    setError(null);
    setPanel((cur) => (cur === p ? null : p));
    if (p === "source") loadTargets();
    if (p === "mic" || p === "camera") void listDevices();
  };

  const monitor = targets?.monitors.find((m) => m.index === monitorIdx);
  const win = targets?.windows.find((w) => w.id === windowId);
  const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const sourceLabel = surface === "window" ? (win ? short(win.title, 22) : "Window") : monitor ? `Screen ${monitor.index + 1}${monitor.primary ? " (Primary)" : ""}` : "Screen";
  const devLabel = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;
  const pct = progress !== null && progress >= 0 ? Math.round(progress * 100) : null;

  return (
    <div className="cb-shell" ref={shell} onMouseDown={(e) => e.target === e.currentTarget && setPanel(null)}>
      {cardKey && (
        <div className={`cb-card ${cardKey}`} ref={card} key={cardKey}>
          {cardKey === "error" && (
            <div className="cb-error" role="alert">
              <p>{error}</p>
              <button className="cb-icon" onClick={() => setError(null)} aria-label="Dismiss" title="Dismiss">
                <XMarkIcon aria-hidden />
              </button>
            </div>
          )}

          {cardKey === "source" && (
            <>
              <span className="cb-group">Screens</span>
              <div role="radiogroup" aria-label="Screen to record" className="cb-list glide">
                <span className="glide-pill" aria-hidden />
                {(targets?.monitors ?? []).map((m) => (
                  <Choice
                    key={m.index}
                    icon={<ComputerDesktopIcon />}
                    title={`Screen ${m.index + 1}${m.primary ? " (Primary)" : ""}`}
                    note={`${m.width} × ${m.height}`}
                    on={surface === "monitor" && monitorIdx === m.index}
                    onPick={() => {
                      set({ surface: "monitor" });
                      setMonitorIdx(m.index);
                      setPanel(null);
                    }}
                  />
                ))}
              </div>
              <span className="cb-group">
                Windows
                <button className="cb-icon small" onClick={loadTargets} aria-label="Refresh the list" title="Refresh the list">
                  <ArrowPathIcon aria-hidden />
                </button>
              </span>
              <div role="radiogroup" aria-label="Window to record" className="cb-list scroll glide">
                <span className="glide-pill" aria-hidden />
                {targets && !targets.windows.length && <p className="cb-empty">No open windows found.</p>}
                {(targets?.windows ?? []).map((w) => (
                  <Choice
                    key={w.id}
                    icon={<WindowIcon />}
                    title={short(w.title, 44)}
                    on={surface === "window" && windowId === w.id}
                    onPick={() => {
                      set({ surface: "window" });
                      setWindowId(w.id);
                      setPanel(null);
                    }}
                  />
                ))}
              </div>
            </>
          )}

          {cardKey === "mic" && (
            <>
              <span className="cb-group">Microphone</span>
              <div role="radiogroup" aria-label="Microphone" className="cb-list scroll glide">
                <span className="glide-pill" aria-hidden />
                <Choice icon={<MicrophoneIcon />} title="No microphone" on={!mic} onPick={() => set({ mic: "" })} />
                {mics.map((d, i) => (
                  <Choice key={d.deviceId} icon={<MicrophoneIcon />} title={short(devLabel(d, i, "Microphone"), 44)} on={mic === d.deviceId} onPick={() => set({ mic: d.deviceId })} />
                ))}
              </div>
              {!mics.length && <p className="cb-empty">No microphone found. You can record without one.</p>}
              {mic && (
                <>
                  <Setting title="Level">
                    <span className="ui-meter cb-meter" ref={meter} aria-hidden />
                  </Setting>
                  <Setting title="Noise reduction">
                    <Switch on={noise} label="Noise reduction" onChange={(v) => set({ noise: v })} />
                  </Setting>
                </>
              )}
            </>
          )}

          {cardKey === "camera" && (
            <>
              <span className="cb-group">Camera</span>
              <div role="radiogroup" aria-label="Camera" className="cb-list scroll glide">
                <span className="glide-pill" aria-hidden />
                <Choice icon={<VideoCameraSlashIcon />} title="No camera" on={!cam} onPick={() => set({ cam: "" })} />
                {cams.map((d, i) => (
                  <Choice key={d.deviceId} icon={<VideoCameraIcon />} title={short(devLabel(d, i, "Camera"), 44)} on={cam === d.deviceId} onPick={() => set({ cam: d.deviceId })} />
                ))}
              </div>
              {!cams.length && <p className="cb-empty">No camera found.</p>}
              {cam && (
                <>
                  <div className="cb-preview">
                    <div className={`cb-preview-cam ${spot}`} style={{ width: `${BUBBLE_SIZE[camSize] * 130}%` }}>
                      <video ref={camVideo} autoPlay muted playsInline />
                    </div>
                    <div className="rec-spots" role="radiogroup" aria-label="Camera bubble position">
                      {BUBBLE_SPOTS.map((s) => (
                        <button key={s.id} role="radio" aria-checked={spot === s.id} aria-label={s.label} title={s.label} className={`rec-spot ${s.id}${spot === s.id ? " on" : ""}`} onClick={() => set({ spot: s.id })} />
                      ))}
                    </div>
                  </div>
                  <Setting title="Bubble size">
                    <Segmented label="Bubble size" value={camSize} onChange={(v) => set({ camSize: v })} options={[{ value: "small", label: "S" }, { value: "medium", label: "M" }, { value: "large", label: "L" }]} />
                  </Setting>
                </>
              )}
            </>
          )}

          {cardKey === "more" && (
            <div className="cb-more">
              <Segmented wide label="Settings" value={moreTab} onChange={setMoreTab} options={[{ value: "recording", label: "Recording" }, { value: "effects", label: "Effects" }, { value: "script", label: "Script" }]} />
              <div className="cb-more-body" key={moreTab}>
                {moreTab === "recording" && (
                  <div className="cb-box">
                    <Setting title="Frame rate" note="60 fps for smooth motion">
                      <Segmented label="Frame rate" value={fps} onChange={(v) => set({ fps: v })} options={[{ value: 30, label: "30" }, { value: 60, label: "60" }]} />
                    </Setting>
                    <Setting title="Stop after" note={limit ? `Stops by itself at ${limit}:00` : "Records until you stop"}>
                      <Segmented label="Stop after" value={limit} onChange={(v) => set({ limit: v })} options={[{ value: 0, label: "Off" }, { value: 1, label: "1m" }, { value: 5, label: "5m" }, { value: 10, label: "10m" }, { value: 30, label: "30m" }]} />
                    </Setting>
                    <Setting title="Show cursor" note={cursor ? "Shown in the recording" : "Hidden in the recording"}>
                      <Switch on={cursor} label="Show cursor" onChange={(v) => set({ cursor: v })} />
                    </Setting>
                  </div>
                )}
                {moreTab === "effects" && (
                  <>
                    <div className="cb-box">
                      <Setting title="Zoom on clicks" note={clickZoom ? "Smooth zooms where you click" : "Off"}>
                        <Switch on={clickZoom} label="Zoom on clicks" onChange={(v) => set({ clickZoom: v })} />
                      </Setting>
                      {clickZoom && (
                        <>
                          <Slider label="Depth" value={zoomDepth} min={1.2} max={3} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={(v) => set({ zoomDepth: v })} />
                          <Slider label="Hold" value={zoomHold} min={0.5} max={4} step={0.1} format={(v) => `${v.toFixed(1)} s`} onChange={(v) => set({ zoomHold: v })} />
                          <Setting title="Mouse moves on">
                            <Segmented label="When the mouse moves on" value={after} onChange={(v) => set({ after: v })} options={[{ value: "follow", label: "Follow" }, { value: "zoomOut", label: "Zoom out" }]} />
                          </Setting>
                        </>
                      )}
                    </div>
                    <div className="cb-box">
                      <Setting title="Click rings" note="A ring where you click">
                        <Switch on={ripples} label="Click rings" onChange={(v) => set({ ripples: v })} />
                      </Setting>
                    </div>
                  </>
                )}
                {moreTab === "script" && (
                  <div className="cb-box">
                    <Setting title="Teleprompter" note={scriptOn ? "Scrolls above the bar while you record" : "Off"}>
                      <Switch on={scriptOn} label="Teleprompter" onChange={(v) => set({ scriptOn: v })} />
                    </Setting>
                    {scriptOn && (
                      <>
                        <textarea rows={4} value={script} onChange={(e) => setScript(e.target.value)} placeholder="Paste your script here." aria-label="Script" />
                        <Slider label="Speed" value={speed} min={0.25} max={3} step={0.25} format={(v) => `${v}×`} onChange={(v) => set({ speed: v })} />
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="glide cb-more-foot">
                <span className="glide-pill" aria-hidden />
                <button
                  className="cb-link"
                  onClick={() => {
                    setPanel(null);
                    void platform.editor.open(null).catch((e: unknown) => setError(errorMessage(e)));
                  }}
                >
                  <FolderOpenIcon aria-hidden /> Open the library
                </button>
              </div>
            </div>
          )}

          {cardKey === "prompter" && (
            <div className="cb-prompter" ref={prompter}>
              {script}
            </div>
          )}
        </div>
      )}

      <div className={`cb-bar glide ${phase}`} ref={bar}>
        <span className="glide-pill" aria-hidden />
        <span className="cb-grip" onPointerDown={lift} title="Move the bar" aria-hidden>
          <i /><i /><i /><i /><i /><i />
        </span>

        {phase === "idle" && (
          <>
            <button className={panel === "source" ? "cb-source on" : "cb-source"} onClick={() => toggle("source")} aria-haspopup="dialog" aria-expanded={panel === "source"} title="What to record">
              {surface === "window" ? <WindowIcon aria-hidden /> : <ComputerDesktopIcon aria-hidden />}
              <span>{sourceLabel}</span>
              <ChevronUpIcon className="cb-chev" aria-hidden />
            </button>
            <span className="cb-sep" aria-hidden />
            <button className={`cb-icon${mic ? " lit" : " off"}${panel === "mic" ? " open" : ""}`} onClick={() => toggle("mic")} aria-label="Microphone" aria-expanded={panel === "mic"} title={mic ? "Microphone on" : "Microphone off"}>
              <MicrophoneIcon aria-hidden />
            </button>
            <button className={`cb-icon${cam ? " lit" : ""}${panel === "camera" ? " open" : ""}`} onClick={() => toggle("camera")} aria-label="Camera" aria-expanded={panel === "camera"} title={cam ? "Camera on" : "Camera off"}>
              {cam ? <VideoCameraIcon aria-hidden /> : <VideoCameraSlashIcon aria-hidden />}
            </button>
            <button className={systemAudio ? "cb-icon lit" : "cb-icon"} onClick={() => set({ systemAudio: !systemAudio })} role="switch" aria-checked={systemAudio} aria-label="System sound" title={systemAudio ? "System sound on" : "System sound off"}>
              {systemAudio ? <SpeakerWaveIcon aria-hidden /> : <SpeakerXMarkIcon aria-hidden />}
            </button>
            <button className={countdown ? "cb-icon lit" : "cb-icon"} onClick={() => set({ countdown: NEXT_COUNTDOWN[countdown] })} aria-label={`Countdown: ${countdown ? `${countdown} seconds` : "off"}`} title={countdown ? `Countdown ${countdown} s (click to change)` : "No countdown (click to change)"}>
              <ClockIcon aria-hidden />
              {countdown > 0 && <i className="cb-badge">{countdown}</i>}
            </button>
            <button className="cb-rec" onClick={() => void start()} aria-label="Start recording" title="Start recording">
              <span aria-hidden />
            </button>
            <button className={panel === "more" ? "cb-icon open" : "cb-icon"} onClick={() => toggle("more")} aria-label="More settings" aria-expanded={panel === "more"} title="More settings">
              <EllipsisVerticalIcon aria-hidden />
            </button>
            <span className="cb-sep" aria-hidden />
            <button className="cb-icon" onClick={() => void platform.window.minimize()} aria-label="Minimize" title="Minimize">
              <MinusIcon aria-hidden />
            </button>
            <button className="cb-icon" onClick={() => void platform.quit()} aria-label="Quit ReeliF Capture" title="Quit ReeliF Capture">
              <XMarkIcon aria-hidden />
            </button>
          </>
        )}

        {phase === "countdown" && (
          <>
            <span className="cb-count" aria-live="assertive">
              {count}
            </span>
            <span className="cb-status" onPointerDown={lift}>
              <strong>Starting in {count}</strong>
              <em>{sourceLabel}</em>
            </span>
            <button className="btn ghost" onClick={() => (cancelled.current = true)}>
              Cancel
            </button>
          </>
        )}

        {phase === "recording" && (
          <>
            <span className={paused ? "rec-dot idle" : "rec-dot blink"} aria-hidden />
            <span className="cb-time" aria-live="off">
              {formatTime(elapsed)}
            </span>
            <span className="cb-status" onPointerDown={lift}>
              <strong>{paused ? "Paused" : "Recording"}</strong>
              <em>
                {limit ? `Stops at ${limit}:00` : sourceLabel}
                {markers ? ` · ${markers} marker${markers === 1 ? "" : "s"}` : ""}
              </em>
            </span>
            <button className="cb-icon" onClick={addMarker} aria-label="Add a marker" title="Add a marker here">
              <FlagIcon aria-hidden />
            </button>
            <button className="cb-icon" onClick={() => void restart()} aria-label="Restart" title="Throw this take away and record again">
              <ArrowPathIcon aria-hidden />
            </button>
            <button className="cb-icon" onClick={togglePause} aria-label={paused ? "Resume" : "Pause"} title={paused ? "Resume" : "Pause"}>
              {paused ? <PlayIcon aria-hidden /> : <PauseIcon aria-hidden />}
            </button>
            <button className="cb-stop" onClick={() => void stop()}>
              <StopIcon aria-hidden /> Stop
            </button>
            <span className="cb-sep" aria-hidden />
            <button className="cb-icon" onClick={() => void platform.window.minimize()} aria-label="Minimize the bar" title="Minimize the bar (the recording continues)">
              <MinusIcon aria-hidden />
            </button>
          </>
        )}

        {phase === "saving" && (
          <>
            <ArrowPathIcon className="rec-spinner cb-spinner" aria-hidden />
            <span className="cb-status" aria-live="polite" onPointerDown={lift}>
              <strong>Preparing recording</strong>
              <em>
                {STEP_LABEL[step]}
                {pct !== null ? ` · ${pct}%` : ""} · the editor opens in a moment
              </em>
            </span>
            <span className="cb-progress" aria-hidden>
              <i style={pct !== null ? { width: `${pct}%` } : undefined} className={pct === null ? "busy" : ""} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
