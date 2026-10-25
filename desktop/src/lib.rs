// Tauri entry point: run the flood-broker HTTP server in-process (local
// mode), then load the web app. No separate broker process or sidecar.
use flood_broker::readings::{Readings, Store};
use flood_broker::Config;
use std::sync::Arc;

mod updater;

struct SettingsPath(std::path::PathBuf);

#[tauri::command]
fn load_settings(
    path: tauri::State<'_, SettingsPath>,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    // Only expose the editable keys, never unrelated host configuration.
    let values = flood_broker::settings::read(&path.0).map_err(|e| e.to_string())?;
    Ok(values
        .into_iter()
        .filter(|(key, _)| matches!(key.as_str(), "QLD_TRAFFIC_API_KEY" | "NSW_TRAFFIC_API_KEY"))
        .collect())
}

#[tauri::command]
fn save_settings(
    path: tauri::State<'_, SettingsPath>,
    qld_key: Option<String>,
    nsw_key: Option<String>,
) -> Result<(), String> {
    flood_broker::settings::save_keys(
        &path.0,
        qld_key.as_deref().unwrap_or(""),
        nsw_key.as_deref().unwrap_or(""),
    )
    .map_err(|e| e.to_string())
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    if !updater::PUBLIC_KEY.trim().is_empty() {
        builder = builder.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(updater::PUBLIC_KEY)
                .build(),
        );
    }
    builder
        .manage(updater::Updates::default())
        .invoke_handler(tauri::generate_handler![load_settings, save_settings, updater::check_for_update, updater::install_update])
        .setup(|app| {
            use tauri::Manager;
            // Bind before opening the window: a port conflict must fail startup,
            // rather than silently connecting the viewer to another process.
            let listener = std::net::TcpListener::bind("127.0.0.1:8787")?;
            let env = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
            let origins = env("ALLOWED_ORIGINS").unwrap_or_else(|| "http://localhost,tauri://localhost,http://127.0.0.1:1430,http://localhost:1430,http://tauri.localhost,https://tauri.localhost".into());
            let cfg = Config {
                origins: origins.split(',').map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).collect(),
                cache_ms: env("CACHE_MINUTES").and_then(|v| v.parse::<f64>().ok()).map_or(10 * 60_000, |m| (m * 60_000.0) as i64),
                refresh_ms: env("READINGS_REFRESH_MINUTES").and_then(|v| v.parse::<i64>().ok()).filter(|m| *m > 0).unwrap_or(15) * 60_000,
            };
            let data_dir = env("FLOOD_DATA_DIR").unwrap_or_else(|| {
                let home = env("HOME").or_else(|| env("USERPROFILE")).unwrap_or_else(|| ".".into());
                format!("{}/.flood-explorer", home)
            });
            let settings_path = flood_broker::settings::path(std::path::Path::new(&data_dir).join("settings.ini"));
            app.manage(SettingsPath(settings_path.clone()));
            let store = Store::Local(std::path::PathBuf::from(&data_dir));
            let now_ms = || {
                use std::time::{SystemTime, UNIX_EPOCH};
                SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
            };
            let rd = Arc::new(Readings::new(
                Box::new(flood_broker::readings::http_json),
                store,
                env("STATIONS_URL").unwrap_or_else(|| flood_broker::readings::STATIONS_URL.into()),
                Box::new(now_ms),
            )
            .with_text(Box::new(flood_broker::readings::http_text))
            .with_rain_http(Box::new(flood_broker::readings::http_json_once))
            .with_ftp(Box::new(|| flood_feeds::ftp::Session::open(flood_feeds::BOM_FTP_HOST, 30).map(|s| Box::new(s) as Box<dyn flood_feeds::ftp::Dir>)))
            .with_roads(Box::new(move |now, errors| flood_broker::readings::fetch_roads_with_settings(now, errors, &settings_path)))
            .with_emergency(Box::new(flood_broker::readings::fetch_emergency)));
            let rd2 = rd.clone();
            let every = env("READINGS_REFRESH_MINUTES").and_then(|v| v.parse::<u64>().ok()).unwrap_or(15);
            if every > 0 {
                std::thread::spawn(move || loop {
                    match rd2.refresh() {
                        Ok(s) => println!("readings refreshed: {}", s),
                        Err(e) => eprintln!("readings refresh failed: {}", e),
                    }
                    std::thread::sleep(std::time::Duration::from_secs(every * 60));
                });
            }
            let broker = Arc::new(flood_broker::Broker::new(Box::new(flood_broker::http_fetch), Box::new(now_ms), cfg).with_readings(rd));
            std::thread::spawn(move || {
                flood_broker::serve_listener(broker, listener, 4, false);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Flood Explorer");
}
