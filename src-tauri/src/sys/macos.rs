//! macOS: screens are grabbed by FFmpeg's `avfoundation` (capture.rs; the system asks for the
//! Screen Recording permission the first time), the pointer is read through CoreGraphics, and the
//! capture bar asks not to be shared in screen captures.
use std::ffi::c_void;
use std::path::Path;

use super::MonitorScale;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreate(source: *const c_void) -> *mut c_void;
    fn CGEventGetLocation(event: *mut c_void) -> CGPoint;
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

/// kCGEventSourceStateCombinedSessionState, kCGMouseButtonLeft.
const COMBINED_SESSION: i32 = 0;
const LEFT_BUTTON: u32 = 0;

/// Where the pointer is (physical pixels, like the monitors) and whether the left button is down.
pub struct Pointer {
    monitors: Vec<MonitorScale>,
}

impl Pointer {
    pub fn new(monitors: &[MonitorScale]) -> Option<Self> {
        Some(Self { monitors: monitors.to_vec() })
    }

    pub fn read(&mut self) -> Option<(i32, i32, bool)> {
        // SAFETY: a fresh event (released below) only to read the pointer location; the button
        // state is a plain query.
        let (p, down) = unsafe {
            let e = CGEventCreate(std::ptr::null());
            if e.is_null() {
                return None;
            }
            let p = CGEventGetLocation(e);
            CFRelease(e);
            (p, CGEventSourceButtonState(COMBINED_SESSION, LEFT_BUTTON))
        };
        // CoreGraphics gives points; the monitors (and the recording) are in physical pixels.
        let m = self.monitors.iter().find(|m| {
            let (lx, ly) = (m.x as f64 / m.scale, m.y as f64 / m.scale);
            p.x >= lx && p.y >= ly && p.x < lx + m.width as f64 / m.scale && p.y < ly + m.height as f64 / m.scale
        });
        let (x, y) = match m {
            Some(m) => (m.x as f64 + (p.x - m.x as f64 / m.scale) * m.scale, m.y as f64 + (p.y - m.y as f64 / m.scale) * m.scale),
            None => (p.x, p.y),
        };
        Some((x.round() as i32, y.round() as i32, down))
    }
}

/// FFmpeg's avfoundation number for "Capture screen N" (cameras are listed before the screens).
pub fn screen_device(ffmpeg: &Path, screen: u32) -> Option<String> {
    let out = std::process::Command::new(ffmpeg).args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stderr);
    let want = format!("Capture screen {screen}");
    text.lines().find_map(|line| {
        let at = line.find(&want)?;
        let head = line[..at].trim_end();
        let open = head.rfind('[')?;
        let num = head[open + 1..].trim_end_matches(']').trim();
        num.parse::<u32>().ok().map(|n| n.to_string())
    })
}

/// Ask the window server not to share this window in screen captures (NSWindowSharingNone).
/// Newer capture paths may still include it, so callers do not rely on it.
pub fn share_none(ns_window: *mut c_void) {
    if ns_window.is_null() {
        return;
    }
    // SAFETY: a live NSWindow pointer from Tauri; setSharingType: takes an NSUInteger.
    unsafe {
        let obj = &*(ns_window as *const objc2::runtime::AnyObject);
        let _: () = objc2::msg_send![obj, setSharingType: 0usize];
    }
}
