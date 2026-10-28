//! The app's windows. `main` is the floating capture bar (bottom of the screen, always on top,
//! left out of screen captures; it also records). `overlay` is a click-through window over what
//! is being recorded: a frame around it while recording and the countdown before. `editor` is
//! the full window for the library and finished takes; it opens maximized after a recording.
//! `picker` covers one screen while an area to record is dragged out.
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};

pub const BAR: &str = "main";
pub const OVERLAY: &str = "overlay";
pub const EDITOR: &str = "editor";
pub const PICKER: &str = "picker";

/// The take the editor shows when it opens (read once by `editor_take`).
static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+): screen grabs see through the window. Returns true
/// only when Windows reports the window as excluded (read back), so callers can leave out what
/// must never be recorded. Debug builds keep the windows visible to screenshots with
/// REELIF_SHOW_IN_CAPTURE=1.
fn exclude_from_capture(w: &WebviewWindow) -> bool {
    if cfg!(debug_assertions) && std::env::var_os("REELIF_SHOW_IN_CAPTURE").is_some() {
        return true;
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowDisplayAffinity, SetWindowDisplayAffinity};
        const WDA_EXCLUDEFROMCAPTURE: u32 = 0x11;
        let Ok(hwnd) = w.hwnd() else { return false };
        let mut got = 0u32;
        // SAFETY: a valid window handle of this process, a documented flag and a local out value.
        let ok = unsafe { SetWindowDisplayAffinity(hwnd.0 as _, WDA_EXCLUDEFROMCAPTURE) != 0 && GetWindowDisplayAffinity(hwnd.0 as _, &mut got) != 0 };
        if !ok || got != WDA_EXCLUDEFROMCAPTURE {
            log::warn!("window {} could not be left out of screen captures (affinity {got:#x})", w.label());
            return false;
        }
        true
    }
    // macOS: ask not to be shared, but newer capture paths may still record it, so not "true".
    #[cfg(target_os = "macos")]
    {
        if let Ok(ns) = w.ns_window() {
            crate::sys::macos::share_none(ns);
        }
        false
    }
    // X11 has no way to leave a window out of a screen grab.
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = w;
        false
    }
}

/// At start: the bar sits centred above the taskbar of the main screen.
pub fn place_bar(app: &AppHandle) {
    let Some(w) = app.get_webview_window(BAR) else { return };
    let _ = exclude_from_capture(&w);
    if let (Ok(Some(m)), Ok(size)) = (w.primary_monitor(), w.outer_size()) {
        let area = m.work_area();
        let margin = (20.0 * m.scale_factor()) as i32;
        let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
        let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
        let _ = w.set_position(PhysicalPosition { x, y });
    }
    let _ = w.show();
    let _ = w.set_focus();
}

/// Resize the bar's window to its content (logical pixels), keeping its bottom centre in place
/// so the bar stays put while panels open above it.
#[tauri::command]
pub fn bar_fit(app: AppHandle, width: f64, height: f64) -> AppResult<()> {
    let w = app.get_webview_window(BAR).ok_or_else(|| AppError::Invalid("The capture bar is not open.".into()))?;
    let scale = w.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return Ok(()) };
    let nw = (width * scale).round().max(1.0) as u32;
    let nh = (height * scale).round().max(1.0) as u32;
    if nw == size.width && nh == size.height {
        return Ok(());
    }
    let cx = pos.x + size.width as i32 / 2;
    let bottom = pos.y + size.height as i32;
    let _ = w.set_position(PhysicalPosition { x: cx - nw as i32 / 2, y: bottom - nh as i32 });
    let _ = w.set_size(PhysicalSize { width: nw, height: nh });
    Ok(())
}

#[tauri::command]
pub fn bar_show(app: AppHandle) {
    if let Some(w) = app.get_webview_window(BAR) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

/// The overlay over a screen area (physical pixels): transparent, click-through, on top and not
/// recorded. Its page reports `overlay:ready`, then follows `overlay:frame` (draw the frame: only
/// when the window is confirmed out of captures), `overlay:tick` and `overlay:paused`.
/// Async: building a window inside a synchronous command deadlocks on Windows (WebView2).
#[tauri::command]
pub async fn overlay_open(app: AppHandle, x: i32, y: i32, width: u32, height: u32) -> AppResult<bool> {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.destroy();
    }
    let w = WebviewWindowBuilder::new(&app, OVERLAY, WebviewUrl::App("index.html".into()))
        .title("ReeliF overlay")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| AppError::Process(format!("Could not show the recording frame: {e}")))?;
    let _ = w.set_position(PhysicalPosition { x, y });
    let _ = w.set_size(PhysicalSize { width, height });
    // Order matters on Windows: the capture exclusion is refused once the window is layered, which
    // click-through makes it; set first, it stays in force. Read back once shown: the frame is
    // drawn only when Windows confirms the overlay is not recorded.
    exclude_from_capture(&w);
    let _ = w.set_ignore_cursor_events(true);
    let _ = w.show();
    Ok(exclude_from_capture(&w))
}

/// The area picker over one screen (physical pixels): dimmed, on top, takes the mouse. Its page
/// sends `picker:done` with the area (physical pixels from the screen's corner) or null, then
/// closes itself (`picker_close`). Async for the same reason as `overlay_open`.
#[tauri::command]
pub async fn picker_open(app: AppHandle, x: i32, y: i32, width: u32, height: u32) -> AppResult<()> {
    if let Some(w) = app.get_webview_window(PICKER) {
        let _ = w.destroy();
    }
    let w = WebviewWindowBuilder::new(&app, PICKER, WebviewUrl::App("index.html".into()))
        .title("Choose an area")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| AppError::Process(format!("Could not open the area picker: {e}")))?;
    let _ = w.set_position(PhysicalPosition { x, y });
    let _ = w.set_size(PhysicalSize { width, height });
    let _ = exclude_from_capture(&w);
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
pub fn picker_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(PICKER) {
        let _ = w.destroy();
    }
}

/// Fit the overlay to what is recorded once it is known (a window's own rectangle).
#[tauri::command]
pub fn overlay_move(app: AppHandle, x: i32, y: i32, width: u32, height: u32) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.set_position(PhysicalPosition { x, y });
        let _ = w.set_size(PhysicalSize { width, height });
    }
}

#[tauri::command]
pub fn overlay_close(app: AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.destroy();
    }
}

/// Open the editor (maximized) on a take, or on the library when `take` is None.
/// Async for the same reason as `overlay_open`.
#[tauri::command]
pub async fn editor_open(app: AppHandle, take: Option<String>) -> AppResult<()> {
    if let Some(w) = app.get_webview_window(EDITOR) {
        let _ = app.emit_to(EDITOR, "editor:open", take);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    *PENDING.lock().unwrap_or_else(|p| p.into_inner()) = take;
    WebviewWindowBuilder::new(&app, EDITOR, WebviewUrl::App("index.html".into()))
        .title("ReeliF Capture")
        .decorations(false)
        .min_inner_size(900.0, 640.0)
        .inner_size(1280.0, 800.0)
        .maximized(true)
        .focused(true)
        .build()
        .map_err(|e| AppError::Process(format!("Could not open the editor: {e}")))?;
    Ok(())
}

/// What the editor should show first (asked once when its page loads).
#[tauri::command]
pub fn editor_take() -> Option<String> {
    PENDING.lock().unwrap_or_else(|p| p.into_inner()).take()
}

/// Out of the way while recording.
#[tauri::command]
pub fn editor_minimize(app: AppHandle) {
    if let Some(w) = app.get_webview_window(EDITOR) {
        let _ = w.minimize();
    }
}
