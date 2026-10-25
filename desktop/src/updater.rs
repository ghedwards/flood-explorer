//! Signed application updates. The renderer never supplies an endpoint or artifact URL.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Updates {
    busy: AtomicBool,
    pending: Mutex<Option<Update>>,
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Updates {
    fn acquire(&self) -> Result<Busy<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "An update operation is already running.".to_string())?;
        Ok(Busy(&self.busy))
    }
}

pub const PUBLIC_KEY: &str = match option_env!("FLOOD_UPDATER_PUBLIC_KEY") {
    Some(key) => key,
    None => "",
};

fn supported(app: &AppHandle) -> Result<(), String> {
    if PUBLIC_KEY.trim().is_empty() {
        return Err("This build does not have update signing configured. Download a newer installer from GitHub Releases.".into());
    }
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_none() {
        return Err("Self-update is available for the AppImage. Update DEB installations using a new DEB package.".into());
    }
    let _ = app;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, Updates>,
) -> Result<UpdateInfo, String> {
    let _busy = state.acquire()?;
    supported(&app)?;
    *state.pending.lock().map_err(|e| e.to_string())? = None;
    let update = app
        .updater_builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = UpdateInfo {
        current_version: app.package_info().version.to_string(),
        version: update.as_ref().map(|u| u.version.clone()),
        notes: update.as_ref().and_then(|u| u.body.clone()),
    };
    *state.pending.lock().map_err(|e| e.to_string())? = update;
    Ok(info)
}

#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    let _busy = state.acquire()?;
    supported(&app)?;
    let update = {
        let mut pending = state.pending.lock().map_err(|e| e.to_string())?;
        if pending.as_ref().map(|u| u.version.as_str()) != Some(version.as_str()) {
            return Err("Check for updates again before installing.".into());
        }
        pending.take().ok_or("No update is ready to install.")?
    };
    // The plugin verifies the artifact's signature before replacing the app.
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
