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
    /// A bold font file for text labels in exports (forward slashes), if one is found.
    pub font: Option<String>,
}

/// The first bold sans-serif font file found on this system.
fn font() -> Option<String> {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:/Windows".into());
    let list: Vec<String> = if cfg!(windows) {
        ["segoeuib.ttf", "arialbd.ttf", "segoeui.ttf"].iter().map(|f| format!("{windir}/Fonts/{f}")).collect()
    } else if cfg!(target_os = "macos") {
        vec!["/System/Library/Fonts/Supplemental/Arial Bold.ttf".into(), "/Library/Fonts/Arial Bold.ttf".into(), "/System/Library/Fonts/Helvetica.ttc".into()]
    } else {
        vec![
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf".into(),
            "/usr/share/fonts/truetype/ubuntu/Ubuntu-B.ttf".into(),
            "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf".into(),
            "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf".into(),
        ]
    };
    list.into_iter().find(|p| std::path::Path::new(p).is_file()).map(|p| p.replace('\\', "/"))
}

pub fn info() -> PlatformInfo {
    if cfg!(windows) {
        PlatformInfo { os: "windows", system_audio: true, window_capture: true, hides_from_capture: true, blocked: None, font: font() }
    } else if cfg!(target_os = "macos") {
        PlatformInfo { os: "macos", system_audio: false, window_capture: false, hides_from_capture: false, blocked: None, font: font() }
    } else {
        PlatformInfo { os: "linux", system_audio: true, window_capture: true, hides_from_capture: false, blocked: linux_blocked(), font: font() }
    }
}

/// X11 grabbing sees nothing of a Wayland session (only XWayland windows, often black).
fn linux_blocked() -> Option<String> {
    let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland")) || std::env::var_os("WAYLAND_DISPLAY").is_some();
    wayland.then(|| "Screen recording needs an Xorg session. On the login screen, choose \"Ubuntu on Xorg\" (the gear button), then sign in again.".to_string())
}
