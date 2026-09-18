mod bridge;
mod claude_watch;
mod confetti;

use serde::Serialize;
use tauri::Manager;

#[derive(Serialize)]
struct AppInfo {
    name: String,
    version: String,
    host_primary: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        name: "PetDeck".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        host_primary: "claude-code".into(),
    }
}

/// Frontend → Rust log so UI activity shows in the same terminal as the bridge.
#[tauri::command]
fn ui_log(message: String) {
    eprintln!("[pettty-ui] {message}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_info,
            ui_log,
            confetti::confetti_burst,
            bridge::bridge_info,
            bridge::pull_agent_events,
            claude_watch::claude_presence_snapshot
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_always_on_top(true);
            }
            bridge::start(app.handle().clone(), bridge::DEFAULT_PORT);
            claude_watch::start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
