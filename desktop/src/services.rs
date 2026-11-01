//! Open only the service setup pages offered by the desktop Settings panel.
fn service_url(service: &str) -> Option<&'static str> {
    match service {
        "qld" => Some("https://qldtraffic.qld.gov.au/more/Developers-and-Data/"),
        "nsw" => Some("https://opendata.prod.transport.nsw.gov.au/developers/userguide"),
        "google" => Some("https://developers.google.com/flood-forecasting"),
        "guide" => Some("https://github.com/ghedwards/flood-explorer/blob/main/docs/services-and-credentials.md"),
        _ => None,
    }
}

#[tauri::command]
pub fn open_service(service: &str) -> Result<(), String> {
    let url = service_url(service).ok_or("Unknown service setup page")?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url).status()
        .map_err(|_| "Could not open your browser. Open the setup link manually.".to_string())?
        .success()
        .then_some(())
        .ok_or_else(|| "Could not open your browser. Open the setup link manually.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_links_are_fixed_https_pages_not_user_supplied_urls() {
        for service in ["qld", "nsw", "google", "guide"] {
            assert!(service_url(service).unwrap().starts_with("https://"));
        }
        for unknown in ["", "https://example.com", "file:///etc/passwd", "qld; echo injected"] {
            assert_eq!(service_url(unknown), None);
        }
    }
}
