//! ReeliF Capture (by SyntaxilitY): a screen recorder with smooth click zooms. Screen, sound and
//! clicks are captured natively (capture.rs, clicks.rs); FFmpeg makes and exports the videos.
mod capture;
mod clicks;
mod error;
mod hotkeys;
mod jobs;
mod recordings;
mod redact;
mod shell;
mod sys;
mod tools;

use tauri::State;

/// What recording can do on this system (the UI hides what does not work here).
#[tauri::command]
fn platform_info() -> sys::PlatformInfo {
    sys::info()
}

#[tauri::command]
fn cancel_job(registry: State<'_, jobs::JobRegistry>, job_id: String) -> bool {
    registry.cancel(&job_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(hotkeys::plugin())
        .manage(jobs::JobRegistry::default())
        // The microphone and camera are for the recorder's own pages (nothing remote is loaded).
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Microphone | tauri::webview::PermissionKind::Camera => tauri::webview::PermissionResponse::Allow,
            _ => tauri::webview::PermissionResponse::Default,
        })
        // WebKitGTK keeps getUserMedia off unless the page's settings turn it on.
        .on_page_load(|webview, _| {
            #[cfg(target_os = "linux")]
            let _ = webview.with_webview(|w| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                if let Some(s) = w.inner().settings() {
                    s.set_enable_media_stream(true);
                    s.set_enable_mediasource(true);
                }
            });
            #[cfg(not(target_os = "linux"))]
            let _ = webview;
        })
        .setup(|app| {
            shell::place_bar(app.handle());
            hotkeys::register(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cancel_job,
            platform_info,
            hotkeys::hotkeys,
            capture::capture_targets,
            capture::capture_start,
            capture::capture_pause,
            capture::capture_cancel,
            capture::capture_finish,
            capture::capture_encoders,
            clicks::click_log_start,
            clicks::click_log_stop,
            recordings::take_create,
            recordings::take_save,
            recordings::take_get,
            recordings::take_delete,
            recordings::take_export,
            recordings::take_quiet,
            redact::redact_start,
            redact::redact_stop,
            recordings::library_list,
            recordings::raw_start,
            recordings::raw_append,
            recordings::raw_discard,
            recordings::camera_finish,
            recordings::free_space,
            shell::bar_fit,
            shell::bar_show,
            shell::app_quit,
            shell::overlay_open,
            shell::overlay_move,
            shell::overlay_close,
            shell::picker_open,
            shell::picker_close,
            shell::editor_open,
            shell::editor_take,
            shell::editor_minimize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ReeliF Capture");
}
