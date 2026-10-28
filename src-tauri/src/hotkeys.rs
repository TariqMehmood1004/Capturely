//! Keys that work from any app: start or stop recording, pause or resume, add a marker. Each press
//! is sent to the capture bar (window "main") as a `hotkey` event; the bar decides what it means
//! right now. A key another app already owns is skipped and reported to the bar.
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// What each key does, and how the bar shows it.
const KEYS: [(&str, Code, &str); 3] = [("record", Code::KeyR, "Alt+Shift+R"), ("pause", Code::KeyP, "Alt+Shift+P"), ("marker", Code::KeyM, "Alt+Shift+M")];

#[derive(Serialize, Clone)]
pub struct Hotkey {
    pub action: &'static str,
    pub keys: &'static str,
    /// False when another app already uses these keys.
    pub ready: bool,
}

static STATE: Mutex<Vec<Hotkey>> = Mutex::new(Vec::new());

fn shortcut(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), code)
}

/// The plugin, with the handler that forwards presses to the bar.
pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, pressed, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Some((action, _, _)) = KEYS.iter().find(|(_, code, _)| shortcut(*code) == *pressed) {
                let _ = app.emit_to("main", "hotkey", *action);
            }
        })
        .build()
}

/// Register the keys (called once at start).
pub fn register<R: Runtime>(app: &AppHandle<R>) {
    let list = KEYS
        .iter()
        .map(|(action, code, keys)| {
            let ready = match app.global_shortcut().register(shortcut(*code)) {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("{keys} is not available: {e}");
                    false
                }
            };
            Hotkey { action, keys, ready }
        })
        .collect();
    *STATE.lock().unwrap_or_else(|e| e.into_inner()) = list;
}

/// The keys and whether each one works (for the bar's settings and tooltips).
#[tauri::command]
pub fn hotkeys() -> Vec<Hotkey> {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
