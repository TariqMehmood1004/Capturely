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

/// At start: the bar sits centred above the taskbar of the main screen (shown unless started in
/// the background).
pub fn place_bar(app: &AppHandle, show: bool) {
    let Some(w) = app.get_webview_window(BAR) else { return };
    let _ = exclude_from_capture(&w);
    if let (Ok(Some(m)), Ok(size)) = (w.primary_monitor(), w.outer_size()) {
        let area = m.work_area();
        let margin = (20.0 * m.scale_factor()) as i32;
        let x = area.position.x + (area.size.width as i32 - size.width as i32) / 2;
        let y = area.position.y + area.size.height as i32 - size.height as i32 - margin;
        let _ = w.set_position(PhysicalPosition { x, y });
    }
    if show {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The bar comes back when it was hidden or minimized (a shortcut key, the tray icon).
pub fn reveal_bar(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(BAR) {
        if !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
            keep_on_screen(&w);
            let _ = w.show();
        }
    }
}

/// The tray icon: the app keeps running there (for the shortcut keys) while the bar is hidden.
/// Click: show the bar; menu: show, record, quit.
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let show = MenuItem::with_id(app, "show", "Show the capture bar", true, None::<&str>)?;
    let record = MenuItem::with_id(app, "record", "Start or stop recording (Alt+Shift+R)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Capturely", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &record, &quit])?;
    let mut tray = TrayIconBuilder::with_id("capturely")
        .tooltip("Capturely: Alt+Shift+R starts recording")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id().as_ref() {
            "show" => bar_show(app.clone()),
            "record" => {
                reveal_bar(app);
                let _ = app.emit_to(BAR, "hotkey", "record");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|icon, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                bar_show(icon.app_handle().clone());
            }
        });
    if let Some(img) = app.default_window_icon() {
        tray = tray.icon(img.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Hide the bar to the tray: the app keeps running, so the shortcut keys still work.
#[tauri::command]
pub fn bar_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(BAR) {
        let _ = w.hide();
    }
}

/// Resize the bar's window to its content (logical pixels), keeping its bottom centre in place
/// so the bar stays put while panels open above it.
#[tauri::command]
pub fn bar_fit(app: AppHandle, width: f64, height: f64, dock: Option<String>) -> AppResult<()> {
    let w = app.get_webview_window(BAR).ok_or_else(|| AppError::Invalid("The capture bar is not open.".into()))?;
    let scale = w.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return Ok(()) };
    let nw = (width * scale).round().max(1.0) as u32;
    let nh = (height * scale).round().max(1.0) as u32;
    // The shape changed (it stood up or lay down): it turns about its middle, so it stays where
    // it was let go. Otherwise, lying along the bottom it grows from its bottom centre; standing at
    // a side, from that side and its middle.
    static LAST: Mutex<Option<String>> = Mutex::new(None);
    let side = dock.clone().unwrap_or_else(|| "bottom".into());
    let turned = LAST.lock().unwrap_or_else(|p| p.into_inner()).replace(side.clone()).is_some_and(|l| l != side);
    if nw == size.width && nh == size.height {
        return Ok(());
    }
    let cx = pos.x + size.width as i32 / 2;
    let cy = pos.y + size.height as i32 / 2;
    let (x, y) = match side.as_str() {
        "left" => (pos.x, cy - nh as i32 / 2),
        "right" => (pos.x + size.width as i32 - nw as i32, cy - nh as i32 / 2),
        _ if turned => (cx - nw as i32 / 2, cy - nh as i32 / 2),
        _ => (cx - nw as i32 / 2, pos.y + size.height as i32 - nh as i32),
    };
    let (x, y) = on_screen(&w, x, y, nw, nh);
    let _ = w.set_position(PhysicalPosition { x, y });
    let _ = w.set_size(PhysicalSize { width: nw, height: nh });
    Ok(())
}

/// A window position moved just enough that the window lies inside its screen's work area.
fn on_screen(w: &WebviewWindow, x: i32, y: i32, width: u32, height: u32) -> (i32, i32) {
    let Some(a) = work_area(w) else { return (x, y) };
    (x.clamp(a.x, (a.x + a.w - width as i32).max(a.x)), y.clamp(a.y, (a.y + a.h - height as i32).max(a.y)))
}

/// Bring the bar back inside its screen (it can be dragged partly off it, or left there).
fn keep_on_screen(w: &WebviewWindow) {
    if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
        let (x, y) = on_screen(w, pos.x, pos.y, size.width, size.height);
        if (x, y) != (pos.x, pos.y) {
            let _ = w.set_position(PhysicalPosition { x, y });
        }
    }
}

struct Area {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// The work area (the screen without the taskbar) of the screen the window is on.
fn work_area(w: &WebviewWindow) -> Option<Area> {
    // A window off every screen has no current one: then the main screen.
    let m = w.current_monitor().ok().flatten().or_else(|| w.primary_monitor().ok().flatten())?;
    let a = m.work_area();
    Some(Area { x: a.position.x, y: a.position.y, w: a.size.width as i32, h: a.size.height as i32 })
}

/// After the bar was moved: pushed against the left or right edge of its screen it docks there
/// (snapped flush to the edge, standing upright in the page); anywhere else it lies flat.
/// Returns "left", "right" or "bottom".
#[tauri::command]
pub fn bar_dock(app: AppHandle) -> String {
    let Some(w) = app.get_webview_window(BAR) else { return "bottom".into() };
    let (Ok(pos), Ok(size), Some(a)) = (w.outer_position(), w.outer_size(), work_area(&w)) else { return "bottom".into() };
    let scale = w.scale_factor().unwrap_or(1.0);
    // The window has a clear margin around the bar (for its shadow): the bar itself is about
    // 22 px in, so "at the edge" allows that plus a little.
    let near = (48.0 * scale) as i32;
    let left = pos.x - a.x;
    let right = a.x + a.w - (pos.x + size.width as i32);
    if left <= near && left <= right {
        let _ = w.set_position(PhysicalPosition { x: a.x, y: pos.y });
        keep_on_screen(&w);
        "left".into()
    } else if right <= near {
        let _ = w.set_position(PhysicalPosition { x: a.x + a.w - size.width as i32, y: pos.y });
        keep_on_screen(&w);
        "right".into()
    } else {
        keep_on_screen(&w);
        "bottom".into()
    }
}

/// Wait for the drag the bar just started to end, then dock it (as `bar_dock`). Windows runs the
/// drag itself and tells the page nothing when it ends, so the end is the left mouse button going
/// up; elsewhere, the window standing still for a moment.
#[tauri::command]
pub async fn bar_drag_end(app: AppHandle) -> String {
    let started = std::time::Instant::now();
    let limit = std::time::Duration::from_secs(120);
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        // SAFETY: a plain query of the mouse button's state.
        let down = || unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 };
        // The press that started the drag may take a moment to register.
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        while down() && started.elapsed() < limit {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
    #[cfg(not(windows))]
    {
        let pos = || app.get_webview_window(BAR).and_then(|w| w.outer_position().ok()).map(|p| (p.x, p.y));
        let mut last = pos();
        let mut still = std::time::Instant::now();
        while still.elapsed() < std::time::Duration::from_millis(350) && started.elapsed() < limit {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let now = pos();
            if now != last {
                last = now;
                still = std::time::Instant::now();
            }
        }
    }
    bar_dock(app)
}

#[tauri::command]
pub fn bar_show(app: AppHandle) {
    if let Some(w) = app.get_webview_window(BAR) {
        let _ = w.unminimize();
        keep_on_screen(&w);
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
        .title("Capturely overlay")
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
        .title("Capturely")
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
