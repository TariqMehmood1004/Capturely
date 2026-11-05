//! Files a take uses besides its recording, and files from outside the library: pictures and
//! sounds added in the editor (copied into the take's `media` folder, so a take stays whole),
//! shapes the editor draws (PNG), the built-in wallpapers and the Wallpapers folder, videos opened
//! as new takes, camera footage, and `.capturely` project files. Every open or save dialog is
//! shown from here, so a path to read or write never comes from the page.
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::jobs::{new_command, JobRegistry};
use crate::recordings::{allow, library_dir, raw_dir, render, take_create, take_dir};
use crate::tools;

const PICTURES: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp"];
const SOUNDS: &[&str] = &["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"];
const VIDEOS: &[&str] = &["mp4", "mov", "mkv", "webm", "avi", "m4v"];
const PROJECT_EXT: &str = "capturely";

/// A file name the app may use inside one of its own folders: no folders, nothing odd.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 120 && name != "." && name != ".." && !name.chars().any(|c| "<>:\"/\\|?*".contains(c) || c.is_control())
}

/// The take's own folder for added files.
pub fn media_dir(take: &Path) -> AppResult<PathBuf> {
    let dir = take.join("media");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Videos\Capturely\Wallpapers: pictures put here show up as backgrounds.
pub fn wallpapers_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = library_dir(app)?.join("Wallpapers");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The wallpapers built into the app (src/assets/wallpapers, scripts/make-wallpapers.py), written
/// once next to the raw recordings for FFmpeg to read.
fn builtin_wallpaper(app: &AppHandle, id: &str) -> AppResult<PathBuf> {
    let bytes: &[u8] = match id {
        "aurora" => include_bytes!("../../src/assets/wallpapers/aurora.jpg"),
        "lagoon" => include_bytes!("../../src/assets/wallpapers/lagoon.jpg"),
        "ember" => include_bytes!("../../src/assets/wallpapers/ember.jpg"),
        "meadow" => include_bytes!("../../src/assets/wallpapers/meadow.jpg"),
        "nebula" => include_bytes!("../../src/assets/wallpapers/nebula.jpg"),
        "dune" => include_bytes!("../../src/assets/wallpapers/dune.jpg"),
        _ => return Err(AppError::Invalid("Unknown wallpaper.".into())),
    };
    let p = raw_dir(app)?.join(format!("wallpaper-{id}.jpg"));
    if std::fs::metadata(&p).map(|m| m.len() != bytes.len() as u64).unwrap_or(true) {
        std::fs::write(&p, bytes)?;
    }
    Ok(p)
}

/// The file behind a picture or sound reference: "media:<name>" (the take's), "builtin:<id>",
/// "wallpaper:<name>".
pub fn resolve_ref(app: &AppHandle, take: &Path, reference: &str) -> AppResult<PathBuf> {
    let (kind, name) = reference.split_once(':').ok_or_else(|| AppError::Invalid("Unknown file.".into()))?;
    if !safe_name(name) {
        return Err(AppError::Invalid("Invalid file name.".into()));
    }
    let p = match kind {
        "media" => take.join("media").join(name),
        "wallpaper" => wallpapers_dir(app)?.join(name),
        "builtin" => builtin_wallpaper(app, name)?,
        _ => return Err(AppError::Invalid("Unknown file.".into())),
    };
    if !p.is_file() {
        return Err(AppError::Invalid(format!("{name} is missing.")));
    }
    Ok(p)
}

/// A name in `dir` like `stem.ext` that is not taken yet (`stem 2.ext`, ...).
fn free_name(dir: &Path, stem: &str, ext: &str) -> String {
    let stem: String = stem.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control()).take(60).collect();
    let stem = stem.trim().trim_end_matches('.');
    let stem = if stem.is_empty() { "file" } else { stem };
    let mut name = format!("{stem}.{ext}");
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{stem} {n}.{ext}");
        n += 1;
    }
    name
}

fn pick(app: &AppHandle, title: &str, label: &str, exts: &[&str]) -> AppResult<Option<PathBuf>> {
    let Some(p) = app.dialog().file().set_title(title).add_filter(label, exts).blocking_pick_file() else {
        return Ok(None);
    };
    p.into_path().map(Some).map_err(|e| AppError::Invalid(e.to_string()))
}

fn ext_of(p: &Path) -> String {
    p.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase()
}

/// Length in seconds of a sound or video file (None when FFprobe cannot tell).
fn probe_duration(p: &Path) -> Option<f64> {
    let out = std::process::Command::new(tools::ffprobe().ok()?).args(["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1"]).arg(p).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().ok().filter(|d| d.is_finite() && *d > 0.0)
}

#[derive(Serialize)]
pub struct MediaFile {
    /// The reference the take keeps ("media:<name>").
    pub reference: String,
    pub path: String,
    /// The name of the file the user picked.
    pub label: String,
    /// Sounds: their length in seconds.
    pub duration: Option<f64>,
}

/// Add a picture (`kind` "image") or a sound ("audio") to a take: the user picks a file, which is
/// copied into the take's media folder. None when the dialog was closed.
#[tauri::command]
pub async fn media_pick(app: AppHandle, take: String, kind: String) -> AppResult<Option<MediaFile>> {
    let dir = take_dir(&app, &take)?;
    let (title, label, exts) = match kind.as_str() {
        "image" => ("Add a picture", "Pictures", PICTURES),
        "audio" => ("Add sound", "Sound", SOUNDS),
        _ => return Err(AppError::Invalid("Unknown file kind.".into())),
    };
    let Some(src) = pick(&app, title, label, exts)? else { return Ok(None) };
    let ext = ext_of(&src);
    if !exts.contains(&ext.as_str()) {
        return Err(AppError::Invalid(format!("Choose a {} file.", exts.join(", "))));
    }
    if std::fs::metadata(&src)?.len() > 2_000_000_000 {
        return Err(AppError::Invalid("That file is too large.".into()));
    }
    let media = media_dir(&dir)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let name = free_name(&media, &stem, &ext);
    let out = media.join(&name);
    std::fs::copy(&src, &out)?;
    allow(&app, &out);
    let duration = if kind == "audio" { probe_duration(&out) } else { None };
    if kind == "audio" && duration.is_none() {
        let _ = std::fs::remove_file(&out);
        return Err(AppError::Invalid("That sound file could not be read.".into()));
    }
    Ok(Some(MediaFile { reference: format!("media:{name}"), path: out.display().to_string(), label: src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(name), duration }))
}

/// Write a PNG the editor drew (a shape) into the take's media folder: the raw request body, the
/// take in `x-take` and the file name (lower-case letters, digits, dashes, `.png`) in `x-name`.
#[tauri::command]
pub fn media_write(app: AppHandle, request: tauri::ipc::Request<'_>) -> AppResult<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::Invalid("The picture was not received.".into()));
    };
    let header = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let name = header("x-name");
    let ok = name.len() <= 68 && name.strip_suffix(".png").is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    if !ok || !bytes.starts_with(b"\x89PNG") || bytes.len() > 50_000_000 {
        return Err(AppError::Invalid("Invalid picture.".into()));
    }
    let dir = take_dir(&app, &header("x-take"))?;
    let out = media_dir(&dir)?.join(&name);
    std::fs::write(&out, bytes)?;
    Ok(format!("media:{name}"))
}

/// Pictures in the Wallpapers folder (made if missing), for backgrounds.
#[tauri::command]
pub fn wallpapers_list(app: AppHandle) -> AppResult<Vec<String>> {
    let dir = wallpapers_dir(&app)?;
    let mut out: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_file() && PICTURES.contains(&ext_of(p).as_str()) && p.file_name().is_some_and(|n| safe_name(&n.to_string_lossy())))
        .collect();
    out.sort();
    for p in &out {
        allow(&app, p);
    }
    Ok(out.iter().map(|p| p.display().to_string()).collect())
}

#[tauri::command]
pub fn wallpapers_folder(app: AppHandle) -> AppResult<String> {
    Ok(wallpapers_dir(&app)?.display().to_string())
}

/// What a video opened as a new take is like (the editor writes its take.json from this).
#[derive(Serialize)]
pub struct Imported {
    pub take: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration: f64,
}

fn probe_video(p: &Path) -> AppResult<(u32, u32, u32, f64)> {
    let out = std::process::Command::new(tools::ffprobe()?)
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate:format=duration", "-of", "default=nw=1"])
        .arg(p)
        .output()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(k).and_then(|v| v.strip_prefix('='))).map(str::trim).unwrap_or_default().to_string();
    let width: u32 = get("width").parse().unwrap_or(0);
    let height: u32 = get("height").parse().unwrap_or(0);
    let rate = get("avg_frame_rate");
    let fps = rate.split_once('/').and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok().filter(|b| *b > 0.0)?)).unwrap_or(30.0);
    let duration: f64 = get("duration").parse().unwrap_or(0.0);
    if width == 0 || height == 0 || duration <= 0.0 {
        return Err(AppError::Invalid("That video could not be read.".into()));
    }
    Ok((width, height, fps.round().clamp(1.0, 120.0) as u32, duration))
}

/// Open a video file as a new take: it is converted into the take's recording.mp4 (H.264, even
/// size, AAC sound). None when the dialog was closed.
#[tauri::command]
pub async fn library_import(app: AppHandle, registry: State<'_, JobRegistry>, job_id: String) -> AppResult<Option<Imported>> {
    let Some(src) = pick(&app, "Open a video", "Videos", VIDEOS)? else { return Ok(None) };
    let (_, _, fps, duration) = probe_video(&src)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Video".into());
    let stem: String = stem.chars().filter(|c| !"<>:\"/\\|?*".contains(*c) && !c.is_control()).take(70).collect();
    let take = take_create(app.clone(), if stem.trim().is_empty() { "Video".into() } else { stem })?;
    let dir = PathBuf::from(&take);
    let out = dir.join("recording.mp4");
    let mut cmd = new_command(&tools::ffmpeg()?);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(&src);
    cmd.args(["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:a", "aac", "-b:a", "192k"]);
    if let Err(e) = render(&app, &registry, &job_id, cmd, &out, duration, "the video").await {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    let (width, height, _, duration) = probe_video(&out)?;
    Ok(Some(Imported { take, width, height, fps, duration }))
}

/// Use other footage as the take's camera (uploaded or replaced): converted into camera.mp4.
/// None when the dialog was closed.
#[tauri::command]
pub async fn camera_import(app: AppHandle, registry: State<'_, JobRegistry>, job_id: String, take: String) -> AppResult<Option<String>> {
    let dir = take_dir(&app, &take)?;
    let Some(src) = pick(&app, "Choose camera footage", "Videos", VIDEOS)? else { return Ok(None) };
    let (_, _, _, duration) = probe_video(&src)?;
    let out = dir.join("camera.mp4");
    let mut cmd = new_command(&tools::ffmpeg()?);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-i"]).arg(&src);
    cmd.args(["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]);
    render(&app, &registry, &job_id, cmd, &out, duration, "the camera video").await?;
    Ok(Some(out.display().to_string()))
}

/// Remove the take's camera footage (the user confirmed it in the app).
#[tauri::command]
pub fn camera_remove(app: AppHandle, take: String) -> AppResult<()> {
    let p = take_dir(&app, &take)?.join("camera.mp4");
    if p.is_file() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

/// Save the take's edit as a project file the user can keep anywhere and open again: the take it
/// belongs to and its take.json. Returns where it was saved (None when the dialog was closed).
#[tauri::command]
pub async fn project_save(app: AppHandle, take: String) -> AppResult<Option<String>> {
    let dir = take_dir(&app, &take)?;
    let data: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("take.json"))?).map_err(|_| AppError::Invalid("The recording's data could not be read.".into()))?;
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Recording".into());
    let Some(p) = app.dialog().file().set_title("Save the project").set_file_name(format!("{name}.{PROJECT_EXT}")).add_filter("Capturely project", &[PROJECT_EXT]).blocking_save_file() else {
        return Ok(None);
    };
    let mut path = p.into_path().map_err(|e| AppError::Invalid(e.to_string()))?;
    if ext_of(&path) != PROJECT_EXT {
        path.set_extension(PROJECT_EXT);
    }
    let project = serde_json::json!({ "format": "capturely-project", "version": 1, "take": dir.display().to_string(), "name": name, "data": data });
    let tmp = path.with_extension("capturely.part");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&project).map_err(|e| AppError::Invalid(e.to_string()))?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(Some(path.display().to_string()))
}

/// Open a project file: its edit goes back into its take (which must still be in the library).
/// Returns the take to open (None when the dialog was closed).
#[tauri::command]
pub async fn project_open(app: AppHandle) -> AppResult<Option<String>> {
    let Some(path) = pick(&app, "Open a project", "Capturely project", &[PROJECT_EXT])? else { return Ok(None) };
    if std::fs::metadata(&path)?.len() > 20 * 1024 * 1024 {
        return Err(AppError::Invalid("That project file is too large.".into()));
    }
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path)?).map_err(|_| AppError::Invalid("That is not a Capturely project.".into()))?;
    if v["format"] != "capturely-project" {
        return Err(AppError::Invalid("That is not a Capturely project.".into()));
    }
    let lib = library_dir(&app)?;
    // The take by its saved path, else by its name in this computer's library (a moved library).
    let saved = v["take"].as_str().map(PathBuf::from);
    let by_name = v["name"].as_str().filter(|n| safe_name(n)).map(|n| lib.join(n));
    let take = [saved, by_name]
        .into_iter()
        .flatten()
        .find_map(|p| take_dir(&app, &p.display().to_string()).ok())
        .ok_or_else(|| AppError::Invalid(format!("The recording \"{}\" is not in the library any more.", v["name"].as_str().unwrap_or("?"))))?;
    if v["data"].is_object() {
        let tmp = take.join("take.json.part");
        std::fs::write(&tmp, serde_json::to_vec(&v["data"]).map_err(|e| AppError::Invalid(e.to_string()))?)?;
        std::fs::rename(tmp, take.join("take.json"))?;
    }
    Ok(Some(take.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::{free_name, safe_name};

    #[test]
    fn file_names_stay_in_their_folder() {
        assert!(safe_name("logo 2.png"));
        assert!(!safe_name("../x.png"));
        assert!(!safe_name("a/b.png"));
        assert!(!safe_name("C:x"));
        assert!(!safe_name(".."));
        let dir = std::env::temp_dir();
        assert_eq!(free_name(&dir, "a/b:c", "png"), "abc.png");
    }
}
