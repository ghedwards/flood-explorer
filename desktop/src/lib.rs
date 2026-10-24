// Tauri entry point: launch the flood-broker sidecar in local mode, then
// load the web app. The sidecar is started on app launch and killed on exit.
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Start the broker sidecar in local mode.
            let sidecar = app.shell().sidecar("flood-broker").unwrap();
            let (_rx, _child) = sidecar
                .env("FLOOD_STORAGE", "local")
                .env("ALLOWED_ORIGINS", "http://localhost,tauri://localhost")
                .spawn()
                .expect("failed to start flood-broker sidecar");
            // TODO: read the port from the sidecar's stdout ("listening on ...")
            // and inject FLOOD_BROKER_URL into the webview before it loads.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Flood Explorer");
}
EOF