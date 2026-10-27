//! Click log for the screen recorder: while a recording runs, a thread polls the global pointer and
//! notes every left-button press and, about 20 times a second, where the pointer is when it moved
//! (milliseconds since the start, screen pixels). The recorder turns them into zooms that follow the
//! pointer (core/recorder.ts, core/screenZoom.ts). Windows (Win32), Linux (X11, sys/linux.rs) and
//! macOS (CoreGraphics, sys/macos.rs); other systems log nothing.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

use crate::sys::MonitorScale;

#[derive(Serialize, Clone, Copy)]
pub struct Click {
    pub ms: f64,
    pub x: i32,
    pub y: i32,
}

struct Log {
    stop: Arc<AtomicBool>,
    clicks: Arc<Mutex<Vec<Click>>>,
    moves: Arc<Mutex<Vec<Click>>>,
}

/// Pointer path: at most one point per this many ms, and only after it moved this many pixels.
const MOVE_EVERY_MS: f64 = 50.0;
const MOVE_MIN_PX: i32 = 3;
const MAX_MOVES: usize = 200_000;

static LOG: Mutex<Option<Log>> = Mutex::new(None);

/// Pointer position (physical screen pixels) and whether the left button is down.
#[cfg(windows)]
struct Pointer;

#[cfg(windows)]
impl Pointer {
    fn new(_monitors: &[MonitorScale]) -> Option<Self> {
        Some(Self)
    }

    fn read(&mut self) -> Option<(i32, i32, bool)> {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut p = POINT { x: 0, y: 0 };
        // SAFETY: plain Win32 queries writing into a local POINT.
        unsafe {
            if GetCursorPos(&mut p) == 0 {
                return None;
            }
            Some((p.x, p.y, (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0))
        }
    }
}

#[cfg(target_os = "linux")]
use crate::sys::linux::Pointer;
#[cfg(target_os = "macos")]
use crate::sys::macos::Pointer;

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
struct Pointer;

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
impl Pointer {
    fn new(_monitors: &[MonitorScale]) -> Option<Self> {
        None
    }

    fn read(&mut self) -> Option<(i32, i32, bool)> {
        None
    }
}

/// Start logging clicks (a running log is replaced).
#[tauri::command]
pub fn click_log_start(app: tauri::AppHandle) {
    let monitors: Vec<MonitorScale> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| MonitorScale { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height, scale: m.scale_factor() })
        .collect();
    let stop = Arc::new(AtomicBool::new(false));
    let clicks = Arc::new(Mutex::new(Vec::new()));
    let moves = Arc::new(Mutex::new(Vec::new()));
    if let Some(old) = LOG.lock().unwrap_or_else(|e| e.into_inner()).replace(Log { stop: stop.clone(), clicks: clicks.clone(), moves: moves.clone() }) {
        old.stop.store(true, Ordering::Relaxed);
    }
    std::thread::spawn(move || {
        // Opened on this thread (an X display is used from the thread that opened it).
        let Some(mut pointer) = Pointer::new(&monitors) else { return };
        let t0 = Instant::now();
        let mut was_down = true; // a press already held at the start is not a click
        let mut last: Option<Click> = None;
        while !stop.load(Ordering::Relaxed) {
            if let Some((x, y, down)) = pointer.read() {
                let ms = t0.elapsed().as_secs_f64() * 1000.0;
                let moved = last.map_or(true, |l| ms - l.ms >= MOVE_EVERY_MS && ((x - l.x).abs() >= MOVE_MIN_PX || (y - l.y).abs() >= MOVE_MIN_PX));
                if moved {
                    let p = Click { ms, x, y };
                    last = Some(p);
                    if let Ok(mut m) = moves.lock() {
                        if m.len() < MAX_MOVES {
                            m.push(p);
                        }
                    }
                }
                if down && !was_down {
                    if let Ok(mut c) = clicks.lock() {
                        if c.len() < 5000 {
                            c.push(Click { ms: t0.elapsed().as_secs_f64() * 1000.0, x, y });
                        }
                    }
                }
                was_down = down;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
    });
}

#[derive(Serialize)]
pub struct Monitor {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
pub struct ClickLog {
    pub clicks: Vec<Click>,
    /// Where the pointer was when it moved (about 20 per second at most).
    pub moves: Vec<Click>,
    /// The monitors in the same (physical pixel) space as the clicks.
    pub monitors: Vec<Monitor>,
}

/// Stop logging; returns the clicks and the monitors they fall on.
#[tauri::command]
pub fn click_log_stop(app: tauri::AppHandle) -> ClickLog {
    let (clicks, moves) = match LOG.lock().unwrap_or_else(|e| e.into_inner()).take() {
        Some(log) => {
            log.stop.store(true, Ordering::Relaxed);
            let c = log.clicks.lock().map(|c| c.clone()).unwrap_or_default();
            let m = log.moves.lock().map(|m| m.clone()).unwrap_or_default();
            (c, m)
        }
        None => (Vec::new(), Vec::new()),
    };
    let monitors = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| Monitor { x: m.position().x, y: m.position().y, width: m.size().width, height: m.size().height })
        .collect();
    ClickLog { clicks, moves, monitors }
}
