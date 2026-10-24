// Tauri entry point: launch the flood-broker sidecar in local mode, then
// load the web app. The sidecar is started on app launch and killed on exit.
use tauri_plugin_shell::ShellExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Start the broker sidecar in local mode on its default port (8787).
            // The webview is built with FLOOD_BROKER_URL=http://127.0.0.1:8787.
            let sidecar = app.shell().sidecar("flood-broker").unwrap();
            let (_rx, _child) = sidecar
                .env("FLOOD_STORAGE", "local")
                .env("ALLOWED_ORIGINS", "http://localhost,tauri://localhost,https://tauri.localhost")
                .spawn()
                .expect("failed to start flood-broker sidecar");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Flood Explorer");
}