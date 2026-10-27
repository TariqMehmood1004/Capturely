//! ReeliF Capture (by SyntaxilitY): a screen recorder with smooth click zooms. Screen, sound and
//! clicks are captured natively (capture.rs, clicks.rs); FFmpeg makes and exports the videos.
mod capture;
mod clicks;
mod error;
mod jobs;
mod recordings;
mod shell;
mod tools;

use tauri::State;

#[tauri::command]
fn cancel_job(registry: State<'_, jobs::JobRegistry>, job_id: String) -> bool {
    registry.cancel(&job_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_opener::init())
        .manage(jobs::JobRegistry::default())
        .setup(|app| {
            shell::place_bar(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cancel_job,
            capture::capture_targets,
            capture::capture_start,
            capture::capture_pause,
            capture::capture_cancel,
            capture::capture_finish,
            clicks::click_log_start,
            clicks::click_log_stop,
            recordings::take_create,
            recordings::take_save,
            recordings::take_get,
            recordings::take_delete,
            recordings::take_export,
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
            shell::editor_open,
            shell::editor_take,
            shell::editor_minimize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ReeliF Capture");
}
