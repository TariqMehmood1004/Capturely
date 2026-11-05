//! Keys that work from any app: start or stop recording, pause or resume, add a marker. Each press
//! is sent to the capture bar (window "main") as a `hotkey` event; the bar decides what it means
//! right now. The keys can be changed (saved in hotkeys.json in the app's settings folder); a key
//! another app already owns is skipped and reported to the bar.
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::error::{AppError, AppResult};

/// Each action and its key when nothing else was chosen.
const DEFAULTS: [(&str, &str); 3] = [("record", "Alt+Shift+R"), ("pause", "Alt+Shift+P"), ("marker", "Alt+Shift+M")];

#[derive(Serialize, Clone)]
pub struct Hotkey {
    pub action: &'static str,
    pub keys: String,
    /// False when another app already uses these keys.
    pub ready: bool,
    #[serde(skip)]
    shortcut: Option<Shortcut>,
}

static STATE: Mutex<Vec<Hotkey>> = Mutex::new(Vec::new());

fn state() -> std::sync::MutexGuard<'static, Vec<Hotkey>> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

/// The plugin, with the handler that forwards presses to the bar. Start/stop also brings a hidden
/// bar back (it runs the recording, and a hidden page's timers are slowed by WebView2).
pub fn plugin() -> tauri::plugin::TauriPlugin<Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, pressed, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let action = state().iter().find(|h| h.shortcut.as_ref() == Some(pressed)).map(|h| h.action);
            if let Some(action) = action {
                if action == "record" {
                    crate::shell::reveal_bar(app);
                }
                let _ = app.emit_to("main", "hotkey", action);
            }
        })
        .build()
}

fn config_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("hotkeys.json"))
}

fn saved<R: Runtime>(app: &AppHandle<R>) -> HashMap<String, String> {
    config_file(app).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save<R: Runtime>(app: &AppHandle<R>, list: &[Hotkey]) {
    let Some(p) = config_file(app) else { return };
    let map: HashMap<&str, &str> = list.iter().map(|h| (h.action, h.keys.as_str())).collect();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(p, json);
    }
}

/// Keys as typed ("Ctrl+Shift+F9"), checked: at least one of Ctrl, Alt, Shift or Win with one
/// other key, so a plain letter is never taken from every app.
fn parse(keys: &str) -> AppResult<Shortcut> {
    let parts: Vec<&str> = keys.split('+').map(str::trim).collect();
    let mods = parts.iter().filter(|p| ["ctrl", "control", "alt", "option", "shift", "super", "win", "cmd", "command"].contains(&p.to_ascii_lowercase().as_str())).count();
    if mods == 0 || parts.len() != mods + 1 {
        return Err(AppError::Invalid("Use Ctrl, Alt, Shift or Win with one more key.".into()));
    }
    let text = keys.replace("Win", "Super");
    Shortcut::from_str(&text).map_err(|_| AppError::Invalid(format!("{keys} is not a key Capturely can use.")))
}

fn try_register<R: Runtime>(app: &AppHandle<R>, s: Shortcut, keys: &str) -> bool {
    match app.global_shortcut().register(s) {
        Ok(()) => true,
        Err(e) => {
            log::warn!("{keys} is not available: {e}");
            false
        }
    }
}

/// Register the keys (called once at start): the saved ones, else the defaults.
pub fn register<R: Runtime>(app: &AppHandle<R>) {
    let chosen = saved(app);
    let list = DEFAULTS
        .iter()
        .map(|(action, default)| {
            let keys = chosen.get(*action).filter(|k| parse(k).is_ok()).cloned().unwrap_or_else(|| default.to_string());
            let shortcut = parse(&keys).ok();
            let ready = shortcut.is_some_and(|s| try_register(app, s, &keys));
            Hotkey { action, keys, ready, shortcut }
        })
        .collect();
    *state() = list;
}

/// The keys and whether each one works (for the bar's settings and tooltips).
#[tauri::command]
pub fn hotkeys() -> Vec<Hotkey> {
    state().clone()
}

/// Change the key for one action (`keys` empty: back to its default). The old key is let go;
/// when the new one cannot be taken, the old one stays.
#[tauri::command]
pub fn hotkeys_set(app: AppHandle, action: String, keys: String) -> AppResult<Vec<Hotkey>> {
    let keys = if keys.trim().is_empty() { DEFAULTS.iter().find(|(a, _)| *a == action).map(|(_, k)| k.to_string()).ok_or_else(|| AppError::Invalid("Unknown action.".into()))? } else { keys.trim().to_string() };
    let new = parse(&keys)?;
    let mut list = state();
    if list.iter().any(|h| h.action != action && h.shortcut == Some(new)) {
        return Err(AppError::Invalid(format!("{keys} is already used by another Capturely key.")));
    }
    let h = list.iter_mut().find(|h| h.action == action).ok_or_else(|| AppError::Invalid("Unknown action.".into()))?;
    if h.shortcut == Some(new) {
        return Ok(list.clone());
    }
    let old = h.shortcut;
    if let (Some(s), true) = (old, h.ready) {
        let _ = app.global_shortcut().unregister(s);
    }
    if try_register(&app, new, &keys) {
        *h = Hotkey { action: h.action, keys, ready: true, shortcut: Some(new) };
    } else {
        // Keep the old key working.
        if let Some(s) = old {
            h.ready = try_register(&app, s, &h.keys);
        }
        return Err(AppError::Invalid(format!("{keys} is taken by another app. Try other keys.")));
    }
    save(&app, &list);
    Ok(list.clone())
}

#[cfg(test)]
mod tests {
    #[test]
    fn keys_need_a_modifier_and_one_key() {
        assert!(super::parse("Alt+Shift+R").is_ok());
        assert!(super::parse("Ctrl+F9").is_ok());
        assert!(super::parse("R").is_err());
        assert!(super::parse("Ctrl+Alt").is_err());
        assert!(super::parse("Ctrl+A+B").is_err());
    }
}
