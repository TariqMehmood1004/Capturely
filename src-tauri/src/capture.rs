//! Native screen capture for the recorder: no system picker and no "sharing your screen" bar.
//! - Windows: a monitor through FFmpeg's Desktop Duplication source (`ddagrab`, smooth at 60 fps,
//!   cursor optional); a window through Windows Graphics Capture (`gfxcapture`): only that
//!   window, also while other windows cover it, and also apps drawn by the GPU (Chromium,
//!   Electron), which GDI grabs record white. System sound from WASAPI loopback (cpal) into a WAV
//!   file, padded with silence where Windows sends nothing.
//! - Linux (X11): `x11grab` of the screen's area (a window: its area); system sound from the
//!   PulseAudio/PipeWire monitor of the default output, recorded into each segment.
//! - macOS: `avfoundation` "Capture screen N"; no system sound (macOS offers none without a driver).
//! Each pause closes a video segment. `capture_finish` joins the segments and mixes system sound and
//! the microphone into one H.264/AAC MP4.
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::jobs::{emit_progress, new_command, run_process, summarize_stderr, JobGuard, JobRegistry};
use crate::tools;

#[derive(Serialize, Clone)]
pub struct CaptureMonitor {
    pub index: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Serialize, Clone)]
pub struct CaptureWindow {
    /// Window handle as a decimal string (JavaScript numbers cannot hold every handle).
    pub id: String,
    pub title: String,
}

#[derive(Serialize)]
pub struct CaptureTargets {
    pub monitors: Vec<CaptureMonitor>,
    pub windows: Vec<CaptureWindow>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSpec {
    /// "monitor", "window", or "area" (part of `monitor`).
    pub kind: String,
    pub monitor: Option<u32>,
    /// For "area": the part of the screen, in physical pixels from the screen's corner.
    #[serde(default)]
    pub area: Option<CaptureRect>,
    pub window: Option<String>,
    pub fps: u32,
    pub cursor: bool,
    pub system_audio: bool,
    /// "cpu" (x264), or a graphics card's encoder: "nvidia" (NVENC), "intel" (Quick Sync), "amd" (AMF).
    #[serde(default = "default_encoder")]
    pub encoder: String,
    /// "standard", "high" or "best".
    #[serde(default = "default_quality")]
    pub quality: String,
    /// FFmpeg's messages and frame counts are kept as capture.log in the take.
    #[serde(default = "default_true")]
    pub keep_log: bool,
}

fn default_encoder() -> String {
    "cpu".into()
}
fn default_quality() -> String {
    "high".into()
}
fn default_true() -> bool {
    true
}

/// The graphics card encoders this computer can use (Windows), checked once.
#[tauri::command]
pub async fn capture_encoders() -> Vec<String> {
    static FOUND: Mutex<Option<Vec<String>>> = Mutex::new(None);
    if let Some(found) = FOUND.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return found;
    }
    let mut found = Vec::new();
    if cfg!(windows) {
        if let Ok(ffmpeg) = tools::ffmpeg() {
            for (id, codec) in [("nvidia", "h264_nvenc"), ("intel", "h264_qsv"), ("amd", "h264_amf")] {
                let mut cmd = new_command(&ffmpeg);
                cmd.args(["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.1", "-pix_fmt", "nv12", "-c:v", codec, "-f", "null", "-"]);
                if matches!(cmd.output().await, Ok(o) if o.status.success()) {
                    found.push(id.to_string());
                }
            }
        }
    }
    *FOUND.lock().unwrap_or_else(|e| e.into_inner()) = Some(found.clone());
    found
}

/// What was started: the recorded area, and how long ago the picture started (seconds), so the
/// recorder's clock starts with the video.
#[derive(Serialize)]
pub struct CaptureStarted {
    pub rect: CaptureRect,
    pub lead: f64,
}

/// The finished recording and its real length in seconds (from FFprobe).
#[derive(Serialize)]
pub struct CaptureResult {
    pub path: String,
    pub duration: Option<f64>,
}

/// What was recorded, in screen pixels (clicks are mapped onto it).
#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

struct Running {
    spec: CaptureSpec,
    /// What is recorded, in screen pixels (Linux grabs this area).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    rect: CaptureRect,
    /// FFmpeg's input device (macOS: the avfoundation screen number).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    device: Option<String>,
    /// System sound is recorded inside each segment (Linux).
    seg_audio: bool,
    dir: PathBuf,
    segments: Vec<PathBuf>,
    ffmpeg: Option<Child>,
    /// When the running segment's FFmpeg was started.
    started: Option<Instant>,
    audio: Option<audio::Loopback>,
    /// System sound started this long before the picture (seconds); skipped when mixing.
    wav_skip: f64,
    /// What happened, for capture.log (each segment's command, encoder fallbacks).
    notes: Vec<String>,
}

static CAPTURE: Mutex<Option<Running>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<Running>> {
    CAPTURE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Screens (in the order FFmpeg numbers them) and visible windows that can be recorded.
#[tauri::command]
pub fn capture_targets(app: AppHandle) -> AppResult<CaptureTargets> {
    let primary = app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let monitors = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| CaptureMonitor {
            index: i as u32,
            name: m.name().cloned().unwrap_or_else(|| format!("Screen {}", i + 1)),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            primary: primary == Some((m.position().x, m.position().y)),
        })
        .collect();
    Ok(CaptureTargets { monitors, windows: win::windows() })
}

/// The screen (or window) as FFmpeg input arguments, for this system.
#[cfg(windows)]
fn video_input(run: &Running, fps: u32, even: &str) -> AppResult<Vec<String>> {
    let spec = &run.spec;
    // Both sources give frames on the graphics card. The CPU encoder needs them in memory; NVENC
    // and AMF take them as they are; Quick Sync takes them mapped to its own frames.
    let to_encoder = match spec.encoder.as_str() {
        "nvidia" | "amd" => String::new(),
        "intel" => ",hwmap=derive_device=qsv,format=qsv".to_string(),
        _ => format!(",hwdownload,format=bgra,{even}"),
    };
    let mut a: Vec<String> = Vec::new();
    match spec.kind.as_str() {
        "monitor" => {
            let idx = spec.monitor.unwrap_or(0);
            a.extend(["-f".into(), "lavfi".into(), "-i".into()]);
            a.push(format!("ddagrab=output_idx={idx}:framerate={fps}:draw_mouse={}{to_encoder}", u8::from(spec.cursor)));
        }
        "area" => {
            // Desktop Duplication cuts the area out on the graphics card (offsets from the
            // screen's corner; capture_start made the size even and kept it on the screen).
            let idx = spec.monitor.unwrap_or(0);
            let r = spec.area.ok_or_else(|| AppError::Invalid("Choose the area to record.".into()))?;
            a.extend(["-f".into(), "lavfi".into(), "-i".into()]);
            a.push(format!(
                "ddagrab=output_idx={idx}:framerate={fps}:draw_mouse={}:offset_x={}:offset_y={}:video_size={}x{}{to_encoder}",
                u8::from(spec.cursor),
                r.x,
                r.y,
                r.width,
                r.height
            ));
        }
        "window" => {
            // That window only (also when covered), by its handle; a resized window keeps its
            // first size, scaled to fit; the size is rounded down to even numbers.
            let hwnd: u64 = spec.window.as_deref().unwrap_or("").parse().map_err(|_| AppError::Invalid("Choose a window to record.".into()))?;
            a.extend(["-f".into(), "lavfi".into(), "-i".into()]);
            a.push(format!(
                "gfxcapture=hwnd={hwnd}:max_framerate={fps}:capture_cursor={}:resize_mode=scale_aspect:width=-2:height=-2{to_encoder}",
                u8::from(spec.cursor)
            ));
        }
        _ => return Err(AppError::Invalid("Unknown capture source.".into())),
    }
    Ok(a)
}

/// X11: the area of the screen (a window's area for a window) from the app's display.
#[cfg(target_os = "linux")]
fn video_input(run: &Running, fps: u32, _even: &str) -> AppResult<Vec<String>> {
    let r = run.rect;
    let mut a: Vec<String> = vec!["-f".into(), "x11grab".into(), "-framerate".into(), fps.to_string(), "-draw_mouse".into(), u8::from(run.spec.cursor).to_string()];
    a.extend(["-video_size".into(), format!("{}x{}", r.width, r.height), "-i".into(), format!("{}+{},{}", crate::sys::linux::display_name(), r.x, r.y)]);
    Ok(a)
}

/// macOS: the avfoundation screen device, without its sound.
#[cfg(target_os = "macos")]
fn video_input(run: &Running, fps: u32, _even: &str) -> AppResult<Vec<String>> {
    let dev = run.device.clone().ok_or_else(|| AppError::Invalid("That screen is not available for recording.".into()))?;
    Ok(vec![
        "-f".into(),
        "avfoundation".into(),
        "-capture_cursor".into(),
        u8::from(run.spec.cursor).to_string(),
        "-framerate".into(),
        fps.to_string(),
        "-i".into(),
        format!("{dev}:none"),
    ])
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn video_input(_run: &Running, _fps: u32, _even: &str) -> AppResult<Vec<String>> {
    Err(AppError::Invalid("Screen recording is not available on this system.".into()))
}

/// Encoder arguments for the chosen encoder and quality. Graphics card encoders exist on Windows only.
fn encoder_args(encoder: &str, quality: &str) -> Vec<String> {
    // standard, high, best: lighter files first.
    let q = |v: [&'static str; 3]| match quality {
        "standard" => v[0],
        "best" => v[2],
        _ => v[1],
    };
    let a: Vec<&str> = match encoder {
        "nvidia" => vec!["-c:v", "h264_nvenc", "-preset", q(["p1", "p2", "p4"]), "-tune", "ll", "-rc", "vbr", "-cq", q(["28", "23", "19"]), "-b:v", "0"],
        "intel" => vec!["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", q(["28", "23", "19"])],
        "amd" => vec!["-c:v", "h264_amf", "-usage", "lowlatency", "-quality", "speed", "-rc", "cqp", "-qp_i", q(["28", "23", "19"]), "-qp_p", q(["30", "25", "21"])],
        // The CPU encoder: the lightest presets, so the computer keeps up while recording.
        _ => vec!["-c:v", "libx264", "-preset", q(["ultrafast", "superfast", "veryfast"]), "-crf", q(["26", "21", "18"]), "-pix_fmt", "yuv420p"],
    };
    a.into_iter().map(String::from).collect()
}

fn ffmpeg_args(run: &Running, out: &std::path::Path) -> AppResult<Vec<String>> {
    let fps = run.spec.fps.clamp(10, 60);
    let even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    // Warnings, and each second the frame count with dropped and repeated frames (for capture.log).
    // FFmpeg only reads the "q" that ends a segment when it reports, so the period stays short.
    let mut a: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-stats", "-stats_period", "1", "-y"].iter().map(|s| s.to_string()).collect();
    a.extend(video_input(run, fps, even)?);
    // Linux: what the computer plays, from the default output's monitor (PulseAudio / PipeWire).
    if run.seg_audio {
        a.extend(["-thread_queue_size", "1024", "-f", "pulse", "-i", "@DEFAULT_MONITOR@", "-map", "0:v", "-map", "1:a", "-c:a", "pcm_s16le"].iter().map(|s| s.to_string()));
    }
    // ddagrab sizes the picture itself; the other sources are evened here. macOS records the
    // whole screen, so an area is cut out of it (X11 grabs the area itself).
    if !cfg!(windows) {
        let crop = match (cfg!(target_os = "macos"), run.spec.kind.as_str(), run.spec.area) {
            (true, "area", Some(r)) => format!("crop={}:{}:{}:{},", r.width, r.height, r.x, r.y),
            _ => String::new(),
        };
        a.extend(["-vf".into(), format!("{crop}{even}")]);
    }
    a.extend(encoder_args(&run.spec.encoder, &run.spec.quality));
    a.push("-r".into());
    a.push(fps.to_string());
    a.push(out.display().to_string());
    Ok(a)
}

/// Start one video segment; a graphics card encoder that fails at once is replaced by the CPU's.
fn spawn_segment(run: &mut Running) -> AppResult<()> {
    match start_segment(run) {
        Err(e) if run.spec.encoder != "cpu" => {
            log::warn!("{} encoder failed, using the CPU: {e}", run.spec.encoder);
            run.notes.push(format!("The {} encoder did not start ({e}); recording with the CPU instead.", run.spec.encoder));
            run.spec.encoder = "cpu".into();
            start_segment(run)
        }
        r => r,
    }
}

/// Start one video segment (stdin kept open: "q" ends it cleanly).
fn start_segment(run: &mut Running) -> AppResult<()> {
    let out = run.dir.join(format!("segment-{}.mkv", run.segments.len()));
    // FFmpeg's own messages go to a file beside the segment, for when the source fails.
    let errors = out.with_extension("log");
    let args = ffmpeg_args(run, &out)?;
    run.notes.push(format!("segment {}: ffmpeg {}", run.segments.len(), args.join(" ")));
    let mut cmd = std::process::Command::new(tools::ffmpeg()?);
    cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::null());
    match std::fs::File::create(&errors) {
        Ok(f) => cmd.stderr(f),
        Err(_) => cmd.stderr(Stdio::null()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| AppError::Process(format!("Could not start the screen capture: {e}")))?;
    let started = Instant::now();
    #[cfg(windows)]
    end_with_app(&child);
    // A source that cannot be opened (a closed window, a missing screen) ends at once.
    std::thread::sleep(Duration::from_millis(400));
    if let Ok(Some(status)) = child.try_wait() {
        let why = std::fs::read_to_string(&errors).unwrap_or_default();
        let why = why.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        log::warn!("screen capture ended at once ({status}): {why}");
        let detail = if why.is_empty() { String::new() } else { format!(" FFmpeg: {}", why.chars().take(160).collect::<String>()) };
        return Err(AppError::Process(format!("The screen capture stopped at once. Choose another screen or window.{detail}")));
    }
    run.segments.push(out);
    run.ffmpeg = Some(child);
    run.started = Some(started);
    Ok(())
}

/// Put a process in a Windows job that is closed (and its processes ended) when the app exits.
#[cfg(windows)]
fn end_with_app(child: &Child) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    static JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    // SAFETY: documented Win32 calls on a handle this process owns for its whole life; the limit
    // structure is zeroed and sized as the API expects.
    let job = *JOB.get_or_init(|| unsafe {
        let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(h, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
        h as usize
    });
    // SAFETY: the child's handle is valid while `child` lives.
    unsafe {
        AssignProcessToJobObject(job as _, child.as_raw_handle() as _);
    }
}

/// End the running segment: "q" lets FFmpeg finish the file; after 8 s it is killed.
fn end_segment(run: &mut Running) {
    if let Some(mut child) = run.ffmpeg.take() {
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(b"q");
            let _ = stdin.flush();
        }
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(8) {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// An area kept on its screen (`sw`×`sh`) with an even size (H.264 needs it), at least 64 px.
fn fit_area(a: CaptureRect, sw: u32, sh: u32) -> AppResult<CaptureRect> {
    let x = a.x.clamp(0, sw as i32 - 1);
    let y = a.y.clamp(0, sh as i32 - 1);
    let width = a.width.min(sw - x as u32) / 2 * 2;
    let height = a.height.min(sh - y as u32) / 2 * 2;
    if width < 64 || height < 64 {
        return Err(AppError::Invalid("The area is too small to record. Drag out a bigger one.".into()));
    }
    Ok(CaptureRect { x, y, width, height })
}

/// Start recording; returns the recorded area in screen pixels (for click zooms).
#[tauri::command]
pub async fn capture_start(app: AppHandle, spec: CaptureSpec) -> AppResult<CaptureStarted> {
    let mut spec = spec;
    if !cfg!(windows) {
        spec.encoder = "cpu".into();
    }
    log::info!("capture start: {} (screen {:?}, window {:?}, {} fps, {} encoder, {} quality)", spec.kind, spec.monitor, spec.window, spec.fps, spec.encoder, spec.quality);
    if let Some(why) = crate::sys::info().blocked {
        return Err(AppError::Invalid(why));
    }
    cancel_now();
    let rect = match spec.kind.as_str() {
        "monitor" => {
            let ms = app.available_monitors().unwrap_or_default();
            let m = ms.get(spec.monitor.unwrap_or(0) as usize).ok_or_else(|| AppError::Invalid("That screen is not connected.".into()))?;
            CaptureRect { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height }
        }
        "area" => {
            let ms = app.available_monitors().unwrap_or_default();
            let m = ms.get(spec.monitor.unwrap_or(0) as usize).ok_or_else(|| AppError::Invalid("That screen is not connected.".into()))?;
            let a = fit_area(spec.area.ok_or_else(|| AppError::Invalid("Choose the area to record.".into()))?, m.size().width, m.size().height)?;
            spec.area = Some(a);
            CaptureRect { x: m.position().x + a.x, y: m.position().y + a.y, width: a.width, height: a.height }
        }
        _ if !crate::sys::info().window_capture => return Err(AppError::Invalid("Window recording is not available on this system yet. Record a screen instead.".into())),
        _ => win::window_rect(spec.window.as_deref().unwrap_or("")).ok_or_else(|| AppError::Invalid("That window is no longer open.".into()))?,
    };
    #[cfg(target_os = "macos")]
    let device = Some(crate::sys::macos::screen_device(&tools::ffmpeg()?, spec.monitor.unwrap_or(0)).ok_or_else(|| AppError::Invalid("macOS did not offer this screen for recording. Allow ReeliF Capture in System Settings > Privacy & Security > Screen Recording, then open it again.".into()))?);
    #[cfg(not(target_os = "macos"))]
    let device = None;
    let dir = crate::recordings::raw_dir(&app)?.join(format!("capture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let seg_audio = cfg!(target_os = "linux") && spec.system_audio;
    let mut run = Running { spec: spec.clone(), rect, device, seg_audio, dir, segments: Vec::new(), ffmpeg: None, started: None, audio: None, wav_skip: 0.0, notes: Vec::new() };
    // System sound starts first (it takes a moment); what it records before the picture starts
    // is skipped when the sound is mixed.
    let audio_at = Instant::now();
    if spec.system_audio && cfg!(windows) {
        // Without a sound device the recording simply has no system sound.
        run.audio = audio::Loopback::start(run.dir.join("system.wav")).ok();
    }
    if let Err(e) = spawn_segment(&mut run) {
        // No sound server (or no output to listen to): record the picture without system sound.
        if !run.seg_audio {
            if let Some(a) = run.audio.take() {
                a.stop();
            }
            let _ = std::fs::remove_dir_all(&run.dir);
            return Err(e);
        }
        log::warn!("system sound unavailable, recording without it: {e}");
        run.seg_audio = false;
        if let Err(e) = spawn_segment(&mut run) {
            if let Some(a) = run.audio.take() {
                a.stop();
            }
            let _ = std::fs::remove_dir_all(&run.dir);
            return Err(e);
        }
    }
    let started = run.started.unwrap_or_else(Instant::now);
    run.wav_skip = started.duration_since(audio_at).as_secs_f64();
    let lead = started.elapsed().as_secs_f64();
    *lock() = Some(run);
    Ok(CaptureStarted { rect, lead })
}

/// Pause (end the segment, stop writing sound) or resume (a new segment).
#[tauri::command]
pub async fn capture_pause(paused: bool) -> AppResult<()> {
    let mut guard = lock();
    let run = guard.as_mut().ok_or_else(|| AppError::Invalid("Nothing is being recorded.".into()))?;
    if let Some(a) = &run.audio {
        a.set_paused(paused);
    }
    if paused {
        end_segment(run);
        Ok(())
    } else if run.ffmpeg.is_none() {
        spawn_segment(run)
    } else {
        Ok(())
    }
}

/// Throw the take away (restart, cancel, closing the recorder).
#[tauri::command]
pub async fn capture_cancel() {
    cancel_now();
}

fn cancel_now() {
    if let Some(mut run) = lock().take() {
        end_segment(&mut run);
        if let Some(a) = run.audio.take() {
            a.stop();
        }
        let _ = std::fs::remove_dir_all(&run.dir);
    }
}

/// One sound of the recording as AAC (`skip`: seconds before the picture started).
async fn sound_track(src: &std::path::Path, skip: f64, length: f64, out: &std::path::Path) -> AppResult<()> {
    let partial = out.with_extension("partial.m4a");
    let mut cmd = new_command(&tools::ffmpeg()?);
    cmd.args(["-hide_banner", "-nostdin", "-v", "error", "-y"]);
    if skip > 0.005 && skip < 10.0 {
        cmd.arg("-ss").arg(format!("{skip:.3}"));
    }
    cmd.arg("-i").arg(src).args(["-vn", "-t", &format!("{length:.3}"), "-c:a", "aac", "-b:a", "160k"]).arg(&partial);
    let o = cmd.output().await?;
    if !o.status.success() {
        let _ = std::fs::remove_file(&partial);
        return Err(AppError::Process(summarize_stderr(&String::from_utf8_lossy(&o.stderr))));
    }
    std::fs::rename(&partial, out)?;
    Ok(())
}

/// The length of a media file in seconds, from FFprobe.
async fn probe_duration(file: &std::path::Path) -> Option<f64> {
    let mut cmd = new_command(&tools::ffprobe().ok()?);
    cmd.args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"]).arg(file);
    let out = cmd.output().await.ok().filter(|o| o.status.success())?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().ok().filter(|d| d.is_finite() && *d > 0.0)
}

/// capture.log in the take: the settings, each segment's command and FFmpeg's own messages (with
/// its frame counts each second: `dup=` counts repeated frames, a sign the computer fell behind).
fn write_log(take: &std::path::Path, spec: &CaptureSpec, notes: &[String], segments: &[PathBuf], finish: &str) {
    let mut body = format!(
        "ReeliF Capture {}\nsource: {}  fps: {}  encoder: {}  quality: {}\n\n",
        env!("CARGO_PKG_VERSION"),
        spec.kind,
        spec.fps,
        spec.encoder,
        spec.quality
    );
    for n in notes {
        body.push_str(n);
        body.push('\n');
    }
    for (i, seg) in segments.iter().enumerate() {
        let text = std::fs::read_to_string(seg.with_extension("log")).unwrap_or_default();
        body.push_str(&format!("\n--- segment {i} ---\n"));
        // Progress lines end in a carriage return; one line each here.
        for line in text.split(['\r', '\n']).map(str::trim_end).filter(|l| !l.is_empty()) {
            body.push_str(line);
            body.push('\n');
        }
    }
    if !finish.trim().is_empty() {
        body.push_str("\n--- joining and sound ---\n");
        body.push_str(finish.trim());
        body.push('\n');
    }
    if let Err(e) = std::fs::write(take.join("capture.log"), body) {
        log::warn!("capture.log: {e}");
    }
}

/// Stop, then join the segments and mix system sound and the microphone (`mic`: a raw recording of
/// the recorder, or none; its first `mic_skip` seconds came before the picture) into the take's
/// recording.mp4; returns its path and real length. The capture folder is removed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn capture_finish(app: AppHandle, registry: State<'_, JobRegistry>, job_id: String, mic: Option<String>, mic_skip: Option<f64>, take: String, duration: f64) -> AppResult<CaptureResult> {
    let take = crate::recordings::take_dir(&app, &take)?;
    tools::validate_job_id(&job_id)?;
    let (dir, all_segments, wav, seg_audio, wav_skip, spec, notes) = {
        let mut guard = lock();
        let mut run = guard.take().ok_or_else(|| AppError::Invalid("Nothing is being recorded.".into()))?;
        end_segment(&mut run);
        let wav = run.audio.take().map(|a| a.stop()).filter(|p| std::fs::metadata(p).map(|m| m.len() > 1024).unwrap_or(false));
        (run.dir, run.segments, wav, run.seg_audio, run.wav_skip, run.spec, run.notes)
    };
    let segments = all_segments.clone();
    let segments: Vec<PathBuf> = segments.into_iter().filter(|s| std::fs::metadata(s).map(|m| m.len() > 0).unwrap_or(false)).collect();
    if segments.is_empty() {
        if spec.keep_log {
            write_log(&take, &spec, &notes, &all_segments, "Nothing was recorded.");
        }
        let _ = std::fs::remove_dir_all(&dir);
        return Err(AppError::Process("Nothing was recorded.".into()));
    }
    let list = dir.join("segments.txt");
    let body: String = segments.iter().map(|s| format!("file '{}'\n", s.display().to_string().replace('\\', "/").replace('\'', "'\\''"))).collect();
    std::fs::write(&list, body)?;
    let mic = match mic {
        Some(m) => Some(crate::recordings::raw_file(&app, &m)?),
        None => None,
    };
    let out = take.join("recording.mp4");
    let partial = out.with_extension("partial.mp4");
    let guard = JobGuard::new(&registry, &job_id);
    let mut cmd = new_command(&tools::ffmpeg()?);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i"]).arg(&list);
    // Sounds to mix: the segments' own (Linux system sound), the system WAV (Windows), the microphone.
    let mut labels: Vec<String> = if seg_audio { vec!["[0:a]".into()] } else { Vec::new() };
    let mic_skip = mic_skip.unwrap_or(0.0);
    for (i, (p, skip)) in [wav.as_ref().map(|w| (w, wav_skip)), mic.as_ref().map(|m| (m, mic_skip))].into_iter().flatten().enumerate() {
        // Sound recorded before the picture started is left out, so both stay in step.
        if skip > 0.005 && skip < 10.0 {
            cmd.arg("-ss").arg(format!("{skip:.3}"));
        }
        cmd.arg("-i").arg(p);
        labels.push(format!("[{}:a]", i + 1));
    }
    let sounds = labels.len();
    cmd.args(["-map", "0:v", "-c:v", "copy"]);
    if sounds > 0 {
        let ins: String = labels.concat();
        let mix = if sounds > 1 { format!("{ins}amix=inputs={sounds}:duration=longest:normalize=0,apad[a]") } else { format!("{ins}apad[a]") };
        cmd.args(["-filter_complex", &mix, "-map", "[a]", "-c:a", "aac", "-b:a", "192k", "-shortest"]);
    }
    cmd.args(["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"]).arg(&partial);
    let app2 = app.clone();
    let id = job_id.clone();
    let res = run_process(cmd, &guard.token, None, |line| {
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                emit_progress(&app2, &id, "recording", (us / 1e6 / duration.max(0.001)).clamp(0.0, 1.0), None);
            }
        }
    })
    .await;
    if spec.keep_log {
        let finish = match &res {
            Ok(o) => o.stderr_tail.clone(),
            Err(e) => e.to_string(),
        };
        write_log(&take, &spec, &notes, &all_segments, &finish);
    }
    let done = match res {
        Ok(o) if o.success => std::fs::rename(&partial, &out).map_err(AppError::from),
        Ok(o) => Err(AppError::Process(format!("Could not make the recording: {}", summarize_stderr(&o.stderr_tail)))),
        Err(e) => Err(e),
    };
    // Each sound also on its own (system.m4a, mic.m4a), so the editor can set their volumes and
    // clean up the microphone. Linux records system sound inside the picture, so there the
    // recording's own sound is all there is.
    if done.is_ok() && !seg_audio {
        let length = probe_duration(&out).await.unwrap_or(duration);
        for (name, src, skip) in [("system", wav.as_ref(), wav_skip), ("mic", mic.as_ref(), mic_skip)] {
            if let Some(src) = src {
                if let Err(e) = sound_track(src, skip, length, &take.join(format!("{name}.m4a"))).await {
                    log::warn!("{name} sound track: {e}");
                }
            }
        }
    }
    let _ = std::fs::remove_file(&partial);
    let _ = std::fs::remove_dir_all(&dir);
    if let Some(m) = mic {
        let _ = std::fs::remove_file(m);
    }
    done?;
    if let Err(e) = app.asset_protocol_scope().allow_file(&out) {
        log::warn!("asset scope: {e}");
    }
    let real = probe_duration(&out).await;
    log::info!("recording made: {:.2} s on the clock, {real:?} s of video", duration);
    Ok(CaptureResult { path: out.display().to_string(), duration: real })
}

#[cfg(windows)]
mod win {
    use super::{CaptureRect, CaptureWindow};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible};

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the &mut Vec passed by `windows()` for the duration of EnumWindows.
        let out = &mut *(lparam as *mut Vec<CaptureWindow>);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return 1;
        }
        // Not ReeliF Capture's own windows (they are left out of captures, so Windows refuses
        // to record them), nor windows Windows keeps hidden ("cloaked": other desktops, apps
        // suspended in the background).
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == std::process::id() {
            return 1;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED as u32, &mut cloaked as *mut u32 as *mut _, 4) == 0 && cloaked != 0 {
            return 1;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return 1;
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        if !title.trim().is_empty() && title != "Program Manager" {
            out.push(CaptureWindow { id: (hwnd as isize).to_string(), title });
        }
        1
    }

    /// Visible, not minimized windows with a title, front to back.
    pub fn windows() -> Vec<CaptureWindow> {
        let mut out: Vec<CaptureWindow> = Vec::new();
        // SAFETY: the callback only reads window data and pushes into `out`, which outlives the call.
        unsafe {
            EnumWindows(Some(each), &mut out as *mut _ as LPARAM);
        }
        out
    }

    /// What the window shows on screen: DWM's frame bounds (without Windows 10's invisible resize
    /// borders), or the window rectangle when DWM has none.
    pub fn window_rect(id: &str) -> Option<CaptureRect> {
        use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
        let hwnd = id.parse::<isize>().ok()? as HWND;
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        // SAFETY: both calls write into a local RECT of the size passed; an invalid handle fails.
        let dwm = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS as u32, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32) } == 0;
        if !dwm && unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
            return None;
        }
        Some(CaptureRect { x: r.left, y: r.top, width: (r.right - r.left).max(0) as u32, height: (r.bottom - r.top).max(0) as u32 })
    }
}

#[cfg(target_os = "linux")]
use crate::sys::linux as win;

#[cfg(not(any(windows, target_os = "linux")))]
mod win {
    use super::{CaptureRect, CaptureWindow};
    pub fn windows() -> Vec<CaptureWindow> {
        Vec::new()
    }
    pub fn window_rect(_id: &str) -> Option<CaptureRect> {
        None
    }
}

/// System sound (what the speakers play) into a 32-bit float WAV.
mod audio {
    use std::io::{Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Instant;

    pub struct Loopback {
        stop: mpsc::Sender<()>,
        paused: Arc<AtomicBool>,
        done: std::thread::JoinHandle<PathBuf>,
    }

    /// WAV header for IEEE float samples; sizes are filled in when the file is closed.
    fn header(rate: u32, channels: u16, data: u32) -> Vec<u8> {
        let mut h = Vec::with_capacity(44);
        h.extend_from_slice(b"RIFF");
        h.extend_from_slice(&(36 + data).to_le_bytes());
        h.extend_from_slice(b"WAVEfmt ");
        h.extend_from_slice(&16u32.to_le_bytes());
        h.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        h.extend_from_slice(&channels.to_le_bytes());
        h.extend_from_slice(&rate.to_le_bytes());
        h.extend_from_slice(&(rate * channels as u32 * 4).to_le_bytes());
        h.extend_from_slice(&(channels * 4).to_le_bytes());
        h.extend_from_slice(&32u16.to_le_bytes());
        h.extend_from_slice(b"data");
        h.extend_from_slice(&data.to_le_bytes());
        h
    }

    impl Loopback {
        #[cfg(windows)]
        pub fn start(path: PathBuf) -> Result<Self, String> {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            let (stop_tx, stop_rx) = mpsc::channel::<()>();
            let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
            let paused = Arc::new(AtomicBool::new(false));
            let p2 = paused.clone();
            let p3 = paused.clone();
            // The stream lives on its own thread (it cannot move between threads).
            let done = std::thread::spawn(move || {
                let fail = |e: String, tx: &mpsc::Sender<Result<(), String>>| {
                    let _ = tx.send(Err(e));
                    path.clone()
                };
                let host = cpal::default_host();
                let Some(dev) = host.default_output_device() else { return fail("No sound output device.".into(), &ready_tx) };
                let cfg = match dev.default_output_config() {
                    Ok(c) if c.sample_format() == cpal::SampleFormat::F32 => c,
                    Ok(_) => return fail("The sound device does not use float samples.".into(), &ready_tx),
                    Err(e) => return fail(e.to_string(), &ready_tx),
                };
                let rate = cfg.sample_rate().0;
                let channels = cfg.channels();
                let Ok(mut file) = std::fs::File::create(&path) else { return fail("Could not create the sound file.".into(), &ready_tx) };
                let _ = file.write_all(&header(rate, channels, 0));
                let (tx, rx) = mpsc::channel::<Vec<f32>>();
                let stream = match dev.build_input_stream(
                    &cfg.config(),
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        if !p2.load(Ordering::Relaxed) {
                            let _ = tx.send(data.to_vec());
                        }
                    },
                    |e| log::warn!("system sound: {e}"),
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => return fail(e.to_string(), &ready_tx),
                };
                if let Err(e) = stream.play() {
                    return fail(e.to_string(), &ready_tx);
                }
                let _ = ready_tx.send(Ok(()));
                // Windows sends nothing while nothing plays: silence is added so sound stays in time.
                let per_sec = rate as f64 * channels as f64;
                let t0 = Instant::now();
                let mut paused_for = 0.0f64;
                let mut paused_at: Option<Instant> = None;
                let mut written: u64 = 0;
                let pad = |file: &mut std::fs::File, written: &mut u64, upto: f64| {
                    let want = (upto * per_sec) as u64 / channels as u64 * channels as u64;
                    if want > *written + (per_sec * 0.05) as u64 {
                        let zeros = vec![0u8; ((want - *written) * 4) as usize];
                        let _ = file.write_all(&zeros);
                        *written = want;
                    }
                };
                loop {
                    if stop_rx.try_recv().is_ok() {
                        break;
                    }
                    let is_paused = p3.load(Ordering::Relaxed);
                    match (is_paused, paused_at) {
                        (true, None) => paused_at = Some(Instant::now()),
                        (false, Some(p)) => {
                            paused_for += p.elapsed().as_secs_f64();
                            paused_at = None;
                        }
                        _ => {}
                    }
                    let active = t0.elapsed().as_secs_f64() - paused_for - paused_at.map_or(0.0, |p| p.elapsed().as_secs_f64());
                    match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                        Ok(chunk) => {
                            // Pad up to where this chunk starts, then write it.
                            pad(&mut file, &mut written, active - chunk.len() as f64 / per_sec);
                            let bytes: Vec<u8> = chunk.iter().flat_map(|s| s.to_le_bytes()).collect();
                            let _ = file.write_all(&bytes);
                            written += chunk.len() as u64;
                        }
                        Err(_) if !is_paused => pad(&mut file, &mut written, active),
                        Err(_) => {}
                    }
                }
                drop(stream);
                let data = (written * 4).min(u32::MAX as u64) as u32;
                let _ = file.seek(SeekFrom::Start(0)).and_then(|_| file.write_all(&header(rate, channels, data)));
                path
            });
            match ready_rx.recv() {
                Ok(Ok(())) => Ok(Self { stop: stop_tx, paused, done }),
                Ok(Err(e)) => Err(e),
                Err(_) => Err("The sound capture did not start.".into()),
            }
        }

        /// Linux records system sound inside the video segments; macOS has none.
        #[cfg(not(windows))]
        pub fn start(_path: PathBuf) -> Result<Self, String> {
            Err("System sound is recorded with the picture here.".into())
        }

        pub fn set_paused(&self, on: bool) {
            self.paused.store(on, Ordering::Relaxed);
        }

        /// Stop and close the file; returns its path.
        pub fn stop(self) -> PathBuf {
            let _ = self.stop.send(());
            self.done.join().unwrap_or_default()
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn float_wav_header() {
            let h = super::header(48_000, 2, 800);
            assert_eq!(h.len(), 44);
            assert_eq!(&h[0..4], b"RIFF");
            assert_eq!(u16::from_le_bytes([h[20], h[21]]), 3);
            assert_eq!(u32::from_le_bytes([h[28], h[29], h[30], h[31]]), 48_000 * 2 * 4);
            assert_eq!(u32::from_le_bytes([h[40], h[41], h[42], h[43]]), 800);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{fit_area, CaptureRect};

    #[test]
    fn area_stays_on_screen_and_even() {
        let a = fit_area(CaptureRect { x: 1800, y: -20, width: 301, height: 455 }, 1920, 1080).unwrap();
        assert_eq!((a.x, a.y, a.width, a.height), (1800, 0, 120, 454));
        assert!(fit_area(CaptureRect { x: 0, y: 0, width: 40, height: 400 }, 1920, 1080).is_err());
    }
}
