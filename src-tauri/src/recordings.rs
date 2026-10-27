//! The library and the files of a take. Every recording is a folder in Videos\ReeliF Capture:
//! `recording.mp4` (screen and sound), `camera.mp4` (optional), `take.json` (clicks, pointer path,
//! markers, settings) and the exports. Raw browser recordings (microphone, camera) stream into the
//! app's private folder while recording and are converted or mixed when the take finishes.
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::jobs::{emit_progress, new_command, run_process, summarize_stderr, JobGuard, JobRegistry};
use crate::tools;

/// Videos\ReeliF Capture (the app's data folder when there is no Videos folder).
pub fn library_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let base = app.path().video_dir().or_else(|_| app.path().app_local_data_dir()).map_err(|e| AppError::Invalid(e.to_string()))?;
    let dir = base.join("ReeliF Capture");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Private folder for raw recordings and capture segments.
pub fn raw_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_local_data_dir().map_err(|e| AppError::Invalid(e.to_string()))?.join("raw");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// A take folder must be one of the library's own folders.
pub fn take_dir(app: &AppHandle, path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    if p.parent() == Some(library_dir(app)?.as_path()) && p.is_dir() {
        Ok(p)
    } else {
        Err(AppError::Invalid("Not a recording of ReeliF Capture.".into()))
    }
}

/// A raw file must be one `raw_start` made (in the raw folder, .webm).
pub fn raw_file(app: &AppHandle, path: &str) -> AppResult<PathBuf> {
    let p = PathBuf::from(path);
    let ok = p.parent() == Some(raw_dir(app)?.as_path()) && p.extension().is_some_and(|e| e == "webm");
    if ok {
        Ok(p)
    } else {
        Err(AppError::Invalid("Not a recording of this app.".into()))
    }
}

fn allow(app: &AppHandle, path: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_file(path) {
        log::warn!("asset scope: {e}");
    }
}

/// A new take folder named after the moment ("Recording 2026-10-27 13.05.12").
#[tauri::command]
pub fn take_create(app: AppHandle, name: String) -> AppResult<String> {
    let clean: String = name.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control()).collect();
    let clean = clean.trim().trim_end_matches('.').to_string();
    if clean.is_empty() || clean.len() > 80 {
        return Err(AppError::Invalid("Invalid recording name.".into()));
    }
    let lib = library_dir(&app)?;
    let mut dir = lib.join(&clean);
    let mut n = 2;
    while dir.exists() {
        dir = lib.join(format!("{clean} ({n})"));
        n += 1;
    }
    std::fs::create_dir_all(&dir)?;
    Ok(dir.display().to_string())
}

/// Write the take's data (take.json).
#[tauri::command]
pub fn take_save(app: AppHandle, take: String, json: String) -> AppResult<()> {
    if json.len() > 20 * 1024 * 1024 || serde_json::from_str::<serde_json::Value>(&json).is_err() {
        return Err(AppError::Invalid("Invalid recording data.".into()));
    }
    let dir = take_dir(&app, &take)?;
    let tmp = dir.join("take.json.part");
    std::fs::write(&tmp, json)?;
    std::fs::rename(tmp, dir.join("take.json"))?;
    Ok(())
}

#[derive(Serialize)]
pub struct TakeInfo {
    pub path: String,
    pub name: String,
    /// take.json as written by the app (null when missing or unreadable).
    pub data: Option<serde_json::Value>,
    pub video: Option<String>,
    pub camera: Option<String>,
    pub exports: Vec<String>,
    pub bytes: u64,
    pub modified: u64,
}

fn take_info(app: &AppHandle, dir: &Path) -> TakeInfo {
    let file = |n: &str| Some(dir.join(n)).filter(|p| p.is_file());
    let video = file("recording.mp4");
    let camera = file("camera.mp4");
    let mut exports: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|r| r.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("Export") && n.to_string_lossy().ends_with(".mp4"))).collect())
        .unwrap_or_default();
    exports.sort();
    for p in video.iter().chain(camera.iter()).chain(exports.iter()) {
        allow(app, p);
    }
    let bytes = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()?.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0);
    let modified = std::fs::metadata(dir).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
    TakeInfo {
        path: dir.display().to_string(),
        name: dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        data: std::fs::read_to_string(dir.join("take.json")).ok().and_then(|s| serde_json::from_str(&s).ok()),
        video: video.map(|p| p.display().to_string()),
        camera: camera.map(|p| p.display().to_string()),
        exports: exports.iter().map(|p| p.display().to_string()).collect(),
        bytes,
        modified,
    }
}

/// Every take with a recording, newest first.
#[tauri::command]
pub fn library_list(app: AppHandle) -> AppResult<Vec<TakeInfo>> {
    let lib = library_dir(&app)?;
    let mut out: Vec<TakeInfo> = std::fs::read_dir(&lib)?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.is_dir()).map(|p| take_info(&app, &p)).filter(|t| t.video.is_some()).collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

#[tauri::command]
pub fn take_get(app: AppHandle, take: String) -> AppResult<TakeInfo> {
    Ok(take_info(&app, &take_dir(&app, &take)?))
}

/// Delete a take folder (the user confirmed it in the app).
#[tauri::command]
pub fn take_delete(app: AppHandle, take: String) -> AppResult<()> {
    std::fs::remove_dir_all(take_dir(&app, &take)?)?;
    Ok(())
}

/// Start a raw browser recording (`kind`: "mic" or "camera"); returns its path.
#[tauri::command]
pub fn raw_start(app: AppHandle, kind: String) -> AppResult<String> {
    if kind != "mic" && kind != "camera" {
        return Err(AppError::Invalid("Unknown recording kind.".into()));
    }
    let p = raw_dir(&app)?.join(format!("{kind}-{}.webm", uuid::Uuid::new_v4()));
    std::fs::File::create(&p)?;
    Ok(p.display().to_string())
}

/// Append one chunk (raw request body) to a raw recording named in the `x-recording` header.
#[tauri::command]
pub fn raw_append(app: AppHandle, request: tauri::ipc::Request<'_>) -> AppResult<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("The recording chunk was not received.".into()));
    };
    let path = request.headers().get("x-recording").and_then(|v| v.to_str().ok()).unwrap_or_default();
    std::fs::OpenOptions::new().append(true).open(raw_file(&app, path)?)?.write_all(bytes)?;
    Ok(())
}

#[tauri::command]
pub fn raw_discard(app: AppHandle, path: String) -> AppResult<()> {
    let _ = std::fs::remove_file(raw_file(&app, &path)?);
    Ok(())
}

/// Run FFmpeg with progress events; the output is written to a partial file and renamed.
async fn render(app: &AppHandle, registry: &JobRegistry, job_id: &str, mut cmd: tokio::process::Command, out: &Path, duration: f64, what: &str) -> AppResult<()> {
    tools::validate_job_id(job_id)?;
    let guard = JobGuard::new(registry, job_id);
    let partial = out.with_extension("partial.mp4");
    cmd.args(["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"]).arg(&partial);
    let app2 = app.clone();
    let id = job_id.to_string();
    let res = run_process(cmd, &guard.token, None, |line| {
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                emit_progress(&app2, &id, "render", (us / 1e6 / duration.max(0.001)).clamp(0.0, 1.0), None);
            }
        }
    })
    .await;
    let done = match res {
        Ok(o) if o.success => std::fs::rename(&partial, out).map_err(AppError::from),
        Ok(o) => Err(AppError::Process(format!("Could not make {what}: {}", summarize_stderr(&o.stderr_tail)))),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&partial);
    done?;
    allow(app, out);
    Ok(())
}

/// The camera's raw recording becomes the take's camera.mp4 (raw file removed).
#[tauri::command]
pub async fn camera_finish(app: AppHandle, registry: State<'_, JobRegistry>, job_id: String, raw: String, take: String, duration: f64) -> AppResult<String> {
    let raw = raw_file(&app, &raw)?;
    let out = take_dir(&app, &take)?.join("camera.mp4");
    let mut cmd = new_command(&tools::ffmpeg()?);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(&raw);
    cmd.args(["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]);
    render(&app, &registry, &job_id, cmd, &out, duration, "the camera video").await?;
    let _ = std::fs::remove_file(raw);
    Ok(out.display().to_string())
}

/// Export: FFmpeg reads the take's recording (input 0) and camera (input 1, when used) and runs the
/// filter graph made by the app (core/exportGraph.ts: zooms, frame, bubble). Arguments are passed as
/// an argv array; the graph is one argument. Returns the export's path in the take folder.
#[tauri::command]
pub async fn take_export(app: AppHandle, registry: State<'_, JobRegistry>, job_id: String, take: String, graph: String, camera: bool, duration: f64, fps: u32) -> AppResult<String> {
    if graph.len() > 2_000_000 {
        return Err(AppError::Invalid("The export is too complex.".into()));
    }
    let dir = take_dir(&app, &take)?;
    let video = dir.join("recording.mp4");
    let cam = dir.join("camera.mp4");
    if !video.is_file() || (camera && !cam.is_file()) {
        return Err(AppError::Invalid("The recording's files are missing.".into()));
    }
    let mut n = 1;
    let mut out = dir.join("Export.mp4");
    while out.exists() {
        n += 1;
        out = dir.join(format!("Export {n}.mp4"));
    }
    let script = tools_tmp(&app, &job_id)?;
    std::fs::write(&script, graph)?;
    let mut cmd = new_command(&tools::ffmpeg()?);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(&video);
    if camera {
        cmd.arg("-i").arg(&cam);
    }
    cmd.arg("-filter_complex_script").arg(&script);
    cmd.args(["-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r"]);
    cmd.arg(fps.clamp(10, 60).to_string());
    cmd.args(["-c:a", "aac", "-b:a", "192k"]);
    // The generated backgrounds and masks never end on their own: the recording's length ends the export.
    cmd.arg("-t").arg(format!("{:.3}", duration.max(0.1)));
    let res = render(&app, &registry, &job_id, cmd, &out, duration, "the export").await;
    let _ = std::fs::remove_file(&script);
    res?;
    // Checked: the file decodes to a video of about the right length.
    let probe = std::process::Command::new(tools::ffprobe()?)
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"])
        .arg(&out)
        .output()?;
    let got: f64 = String::from_utf8_lossy(&probe.stdout).trim().parse().unwrap_or(0.0);
    if got <= 0.0 {
        let _ = std::fs::remove_file(&out);
        return Err(AppError::Validation("The export could not be read back.".into()));
    }
    Ok(out.display().to_string())
}

fn tools_tmp(app: &AppHandle, job_id: &str) -> AppResult<PathBuf> {
    tools::validate_job_id(job_id)?;
    Ok(raw_dir(app)?.join(format!("graph-{job_id}.txt")))
}

#[tauri::command]
pub fn free_space(app: AppHandle) -> AppResult<u64> {
    fs4::available_space(library_dir(&app)?).map_err(AppError::from)
}
