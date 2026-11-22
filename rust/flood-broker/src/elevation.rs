//! Bounded binary passthrough for GA elevation; callers validate the URL.
use std::io::Read;
use std::sync::OnceLock;
use std::time::Duration;

pub const DEFAULT_MAX_BYTES: u64 = 16 << 20;
pub const LAMBDA_MAX_BYTES: u64 = 4_500_000;

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(40)))
            .max_redirects(0) // Do not let an upstream redirect escape the host allowlist.
            .http_status_as_error(false)
            .build()
            .into()
    })
}

pub fn fetch_bounded(url: &str, max_bytes: u64) -> Result<(String, Vec<u8>), String> {
    let mut response = agent()
        .get(url)
        .header("User-Agent", "flood-explorer-broker")
        .call()
        .map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!("elevation upstream HTTP {}", status));
    }
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("elevation response exceeds {} bytes", max_bytes));
    }
    // WCS can return an XML error with HTTP 200. Never cache it as terrain.
    if ![b"II\x2a\0", b"MM\0\x2a", b"II\x2b\0", b"MM\0\x2b"]
        .iter()
        .any(|magic| bytes.starts_with(*magic))
    {
        return Err("elevation service did not return a GeoTIFF".into());
    }
    Ok((content_type, bytes))
}
