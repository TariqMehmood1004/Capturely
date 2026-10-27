//! Native screen capture for the recorder (Windows): no system picker and no "sharing your screen"
//! bar. A monitor is grabbed with FFmpeg's Desktop Duplication source (`ddagrab`, smooth at 60 fps,
//! cursor optional), a single window with `gdigrab`. Each pause closes a video segment; system sound
//! comes from WASAPI loopback (cpal) into a WAV file, padded with silence where Windows sends
//! nothing. `capture_finish` joins the segments and mixes system sound and the microphone into one
//! H.264/AAC MP4. Other systems report that native capture is not available.
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
    /// "monitor" or "window".
    pub kind: String,
    pub monitor: Option<u32>,
    pub window: Option<String>,
    pub fps: u32,
    pub cursor: bool,
    pub system_audio: bool,
}

/// What was recorded, in screen pixels (clicks are mapped onto it).
#[derive(Serialize, Clone, Copy)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

struct Running {
    spec: CaptureSpec,
    dir: PathBuf,
    segments: Vec<PathBuf>,
    ffmpeg: Option<Child>,
    audio: Option<audio::Loopback>,
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

fn ffmpeg_args(spec: &CaptureSpec, out: &std::path::Path) -> AppResult<Vec<String>> {
    let fps = spec.fps.clamp(10, 60);
    let even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-y".into()];
    match spec.kind.as_str() {
        "monitor" => {
            let idx = spec.monitor.unwrap_or(0);
            a.extend(["-f".into(), "lavfi".into(), "-i".into()]);
            a.push(format!("ddagrab=output_idx={idx}:framerate={fps}:draw_mouse={},hwdownload,format=bgra,{even}", u8::from(spec.cursor)));
        }
        "window" => {
            let id: isize = spec.window.as_deref().unwrap_or("").parse().map_err(|_| AppError::Invalid("Choose a window to record.".into()))?;
            a.extend(["-f".into(), "gdigrab".into(), "-framerate".into(), fps.to_string(), "-draw_mouse".into(), u8::from(spec.cursor).to_string()]);
            a.extend(["-i".into(), format!("hwnd=0x{id:x}"), "-vf".into(), even.into()]);
        }
        _ => return Err(AppError::Invalid("Unknown capture source.".into())),
    }
    a.extend(
        ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p", "-r"]
            .iter()
            .map(|s| s.to_string()),
    );
    a.push(fps.to_string());
    a.push(out.display().to_string());
    Ok(a)
}

/// Start one video segment (stdin kept open: "q" ends it cleanly).
fn spawn_segment(run: &mut Running) -> AppResult<()> {
    let out = run.dir.join(format!("segment-{}.mkv", run.segments.len()));
    let mut cmd = std::process::Command::new(tools::ffmpeg()?);
    cmd.args(ffmpeg_args(&run.spec, &out)?).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| AppError::Process(format!("Could not start the screen capture: {e}")))?;
    // A source that cannot be opened (a closed window, a missing screen) ends at once.
    std::thread::sleep(Duration::from_millis(400));
    if let Ok(Some(status)) = child.try_wait() {
        return Err(AppError::Process(format!("The screen capture stopped at once ({status}). Choose another screen or window.")));
    }
    run.segments.push(out);
    run.ffmpeg = Some(child);
    Ok(())
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

/// Start recording; returns the recorded area in screen pixels (for click zooms).
#[tauri::command]
pub fn capture_start(app: AppHandle, spec: CaptureSpec) -> AppResult<CaptureRect> {
    if !cfg!(windows) {
        return Err(AppError::Invalid("Native screen capture is available on Windows only.".into()));
    }
    capture_cancel();
    let rect = match spec.kind.as_str() {
        "monitor" => {
            let ms = app.available_monitors().unwrap_or_default();
            let m = ms.get(spec.monitor.unwrap_or(0) as usize).ok_or_else(|| AppError::Invalid("That screen is not connected.".into()))?;
            CaptureRect { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height }
        }
        _ => win::window_rect(spec.window.as_deref().unwrap_or("")).ok_or_else(|| AppError::Invalid("That window is no longer open.".into()))?,
    };
    let dir = crate::recordings::raw_dir(&app)?.join(format!("capture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let mut run = Running { spec: spec.clone(), dir, segments: Vec::new(), ffmpeg: None, audio: None };
    spawn_segment(&mut run)?;
    if spec.system_audio {
        // Without a sound device the recording simply has no system sound.
        run.audio = audio::Loopback::start(run.dir.join("system.wav")).ok();
    }
    *lock() = Some(run);
    Ok(rect)
}

/// Pause (end the segment, stop writing sound) or resume (a new segment).
#[tauri::command]
pub fn capture_pause(paused: bool) -> AppResult<()> {
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
pub fn capture_cancel() {
    if let Some(mut run) = lock().take() {
        end_segment(&mut run);
        if let Some(a) = run.audio.take() {
            a.stop();
        }
        let _ = std::fs::remove_dir_all(&run.dir);
    }
}

/// Stop, then join the segments and mix system sound and the microphone (`mic`: a raw recording of
/// the recorder, or none) into the take's recording.mp4; returns its path. The capture folder is removed.
#[tauri::command]
pub async fn capture_finish(app: AppHandle, registry: State<'_, JobRegistry>, job_id: String, mic: Option<String>, take: String, duration: f64) -> AppResult<String> {
    let take = crate::recordings::take_dir(&app, &take)?;
    tools::validate_job_id(&job_id)?;
    let (dir, segments, wav) = {
        let mut guard = lock();
        let mut run = guard.take().ok_or_else(|| AppError::Invalid("Nothing is being recorded.".into()))?;
        end_segment(&mut run);
        let wav = run.audio.take().map(|a| a.stop()).filter(|p| std::fs::metadata(p).map(|m| m.len() > 1024).unwrap_or(false));
        (run.dir, run.segments, wav)
    };
    let segments: Vec<PathBuf> = segments.into_iter().filter(|s| std::fs::metadata(s).map(|m| m.len() > 0).unwrap_or(false)).collect();
    if segments.is_empty() {
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
    let mut sounds = 0;
    for p in [wav.as_ref(), mic.as_ref()].into_iter().flatten() {
        cmd.arg("-i").arg(p);
        sounds += 1;
    }
    cmd.args(["-map", "0:v", "-c:v", "copy"]);
    if sounds > 0 {
        let ins: String = (1..=sounds).map(|i| format!("[{i}:a]")).collect();
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
    let done = match res {
        Ok(o) if o.success => std::fs::rename(&partial, &out).map_err(AppError::from),
        Ok(o) => Err(AppError::Process(format!("Could not make the recording: {}", summarize_stderr(&o.stderr_tail)))),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&partial);
    let _ = std::fs::remove_dir_all(&dir);
    if let Some(m) = mic {
        let _ = std::fs::remove_file(m);
    }
    done?;
    if let Err(e) = app.asset_protocol_scope().allow_file(&out) {
        log::warn!("asset scope: {e}");
    }
    Ok(out.display().to_string())
}

#[cfg(windows)]
mod win {
    use super::{CaptureRect, CaptureWindow};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible};

    unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: lparam is the &mut Vec passed by `windows()` for the duration of EnumWindows.
        let out = &mut *(lparam as *mut Vec<CaptureWindow>);
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
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

    pub fn window_rect(id: &str) -> Option<CaptureRect> {
        let hwnd = id.parse::<isize>().ok()? as HWND;
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        // SAFETY: GetWindowRect writes into a local RECT; an invalid handle returns 0.
        if unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
            return None;
        }
        Some(CaptureRect { x: r.left, y: r.top, width: (r.right - r.left).max(0) as u32, height: (r.bottom - r.top).max(0) as u32 })
    }
}

#[cfg(not(windows))]
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

        #[cfg(not(windows))]
        pub fn start(_path: PathBuf) -> Result<Self, String> {
            Err("System sound capture is available on Windows only.".into())
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

/// Label of the floating recording bar (its page renders `ui/RecorderHud.tsx`).
pub const HUD: &str = "recorder-hud";

/// Open the floating recording bar: a small frameless window, always on top, near the top of the
/// main screen, left out of screen captures (Windows) so it never appears in the recording.
#[tauri::command]
pub fn hud_open(app: AppHandle) -> AppResult<()> {
    if let Some(w) = app.get_webview_window(HUD) {
        let _ = w.unminimize();
        let _ = w.show();
        return Ok(());
    }
    let w = tauri::WebviewWindowBuilder::new(&app, HUD, tauri::WebviewUrl::App("index.html".into()))
        .title("ReeliF recorder")
        .inner_size(460.0, 64.0)
        .resizable(false)
        .maximizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .focused(false)
        .build()
        .map_err(|e| AppError::Process(format!("Could not open the recording bar: {e}")))?;
    if let Ok(Some(m)) = w.primary_monitor() {
        let size = w.outer_size().unwrap_or(tauri::PhysicalSize { width: 460, height: 64 });
        let x = m.position().x + (m.size().width as i32 - size.width as i32) / 2;
        let _ = w.set_position(tauri::PhysicalPosition { x, y: m.position().y + (m.size().height as f64 * 0.03) as i32 });
    }
    #[cfg(windows)]
    if let Ok(hwnd) = w.hwnd() {
        // WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+): screen grabs see through the bar.
        // SAFETY: a valid window handle of this process and a documented flag.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity(hwnd.0 as _, 0x11);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn hud_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(HUD) {
        let _ = w.destroy();
    }
}
