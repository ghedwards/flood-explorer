//! Bounded binary passthrough for GA elevation; callers validate the URL.
use std::io::Read;
use std::time::Duration;

pub fn fetch(url: &str) -> Result<(String, Vec<u8>), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(40)))
        .max_redirects(0) // Do not let an upstream redirect escape the host allowlist.
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
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
    const MAX_BYTES: u64 = 64 << 20;
    response
        .body_mut()
        .as_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("elevation response exceeds 64 MiB".into());
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
