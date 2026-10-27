//! Locates FFmpeg (bundled sidecar) and the app's folders.
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

const EXE_SUFFIX: &str = if cfg!(windows) { ".exe" } else { "" };

fn search_path(file: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).map(|d| d.join(file)).find(|p| p.is_file())
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
    find_binary("ffmpeg").ok_or_else(|| AppError::ToolMissing("FFmpeg was not found. Reinstall ReeliF Capture.".into()))
}

pub fn ffprobe() -> AppResult<PathBuf> {
    find_binary("ffprobe").ok_or_else(|| AppError::ToolMissing("FFprobe was not found. Reinstall ReeliF Capture.".into()))
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
