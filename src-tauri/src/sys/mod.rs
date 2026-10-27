//! What each desktop system can do for the recorder, and its native parts outside Windows.
//! Windows code stays next to its callers (capture.rs, clicks.rs, shell.rs); Linux (X11) and
//! macOS live in the submodules here.
use serde::Serialize;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;

/// A monitor in physical pixels with its scale (macOS gives the pointer in points).
#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub struct MonitorScale {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// Told to the UI so it only offers what works here.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: &'static str,
    /// What the computer plays can be recorded.
    pub system_audio: bool,
    /// A single window can be chosen.
    pub window_capture: bool,
    /// The capture bar and the frame are left out of recordings.
    pub hides_from_capture: bool,
    /// Why recording cannot start here (e.g. a Wayland session), if so.
    pub blocked: Option<String>,
}

pub fn info() -> PlatformInfo {
    if cfg!(windows) {
        PlatformInfo { os: "windows", system_audio: true, window_capture: true, hides_from_capture: true, blocked: None }
    } else if cfg!(target_os = "macos") {
        PlatformInfo { os: "macos", system_audio: false, window_capture: false, hides_from_capture: false, blocked: None }
    } else {
        PlatformInfo { os: "linux", system_audio: true, window_capture: true, hides_from_capture: false, blocked: linux_blocked() }
    }
}

/// X11 grabbing sees nothing of a Wayland session (only XWayland windows, often black).
fn linux_blocked() -> Option<String> {
    let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland")) || std::env::var_os("WAYLAND_DISPLAY").is_some();
    wayland.then(|| "Screen recording needs an Xorg session. On the login screen, choose \"Ubuntu on Xorg\" (the gear button), then sign in again.".to_string())
}
