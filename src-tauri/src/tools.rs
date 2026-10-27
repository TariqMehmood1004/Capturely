//! Locates FFmpeg: the bundled sidecar on Windows; on Linux and macOS the system's FFmpeg.
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const EXE_SUFFIX: &str = if cfg!(windows) { ".exe" } else { "" };

/// PATH, then the usual install places: apps opened from the macOS Dock or a Linux menu do not get
/// the shell's PATH (Homebrew's /opt/homebrew/bin is missing there).
fn search_path(file: &str) -> Option<PathBuf> {
    let from_env = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let usual: &[&str] = if cfg!(unix) { &["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"] } else { &[] };
    from_env.into_iter().chain(usual.iter().map(PathBuf::from)).map(|d| d.join(file)).find(|p| p.is_file())
}

/// What to do when FFmpeg is missing, for this system.
fn missing(name: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("{name} was not found. Install it with Homebrew (brew install ffmpeg), then open ReeliF Capture again.")
    } else if cfg!(target_os = "linux") {
        format!("{name} was not found. Install it (sudo apt install ffmpeg), then open ReeliF Capture again.")
    } else {
        format!("{name} was not found. Reinstall ReeliF Capture.")
    }
}

/// Find `ffmpeg` / `ffprobe`: env override, bundled sidecar, dev sidecar, then PATH.
pub fn find_binary(name: &str) -> Option<PathBuf> {
    let env_key = format!("REELIF_CAPTURE_{}", name.to_uppercase());
    if let Some(p) = std::env::var_os(&env_key).map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    let file = format!("{name}{EXE_SUFFIX}");
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let p = dir.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }
    // The source checkout only exists on the build machine; release builds must not depend on it.
    if cfg!(debug_assertions) {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("{name}-{}{EXE_SUFFIX}", env!("TARGET_TRIPLE")));
        if dev.is_file() {
            return Some(dev);
        }
    }
    search_path(&file)
}

pub fn ffmpeg() -> AppResult<PathBuf> {
    find_binary("ffmpeg").ok_or_else(|| AppError::ToolMissing(missing("FFmpeg")))
}

pub fn ffprobe() -> AppResult<PathBuf> {
    find_binary("ffprobe").ok_or_else(|| AppError::ToolMissing(missing("FFprobe")))
}

/// Job ids come from the UI; restrict them so they are safe as directory names.
pub fn validate_job_id(id: &str) -> AppResult<()> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::Invalid("Invalid job id.".into()))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn job_ids_are_safe_names() {
        assert!(super::validate_job_id("job-1_a").is_ok());
        assert!(super::validate_job_id("../x").is_err());
        assert!(super::validate_job_id("").is_err());
    }
}
