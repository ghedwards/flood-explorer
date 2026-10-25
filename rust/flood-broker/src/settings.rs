//! Shared settings parsing for the standalone broker and desktop app.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn path(default: impl Into<PathBuf>) -> PathBuf {
    env("FLOOD_SETTINGS")
        .map(PathBuf::from)
        .unwrap_or_else(|| default.into())
}

pub fn parse(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('#') || line.starts_with(';') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let (key, value) = (key.trim(), value.trim());
            if key.is_empty() || value.is_empty() {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

pub fn read(path: &Path) -> std::io::Result<BTreeMap<String, String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(parse(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e),
    }
}

pub fn value(path: &Path, key: &str) -> Option<String> {
    env(key).or_else(|| read(path).ok()?.remove(key))
}

/// Keep host settings and comments when changing just the two traffic keys.
pub fn save_keys(path: &Path, qld: &str, nsw: &str) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind, Write};
    if [qld, nsw].iter().any(|v| v.contains(['\r', '\n'])) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "API keys must fit on one line",
        ));
    }
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let keys = ["QLD_TRAFFIC_API_KEY", "NSW_TRAFFIC_API_KEY"];
    let mut lines: Vec<String> = text
        .lines()
        .filter(|line| {
            !line
                .split_once('=')
                .is_some_and(|(key, _)| keys.contains(&key.trim()))
        })
        .map(str::to_string)
        .collect();
    for (key, value) in keys.iter().zip([qld, nsw]) {
        if !value.trim().is_empty() {
            lines.push(format!("{} = {}", key, value.trim()));
        }
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(format!("{}\n", lines.join("\n")).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_comments_whitespace_and_equals_in_keys() {
        let values = parse(
            "# comment\n; comment\nPORT = 8787\nNSW_TRAFFIC_API_KEY = abc==\nempty=\ninvalid\n",
        );
        assert_eq!(values.len(), 2);
        assert_eq!(values["PORT"], "8787");
        assert_eq!(values["NSW_TRAFFIC_API_KEY"], "abc==");
    }

    #[test]
    fn saves_and_clears_keys_preserving_host_settings() {
        let dir = std::env::temp_dir().join(format!("flood-settings-test-{}", std::process::id()));
        let path = dir.join("settings.ini");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            &path,
            "# host config\nPORT=8787\nQLD_TRAFFIC_API_KEY=old\nQLD_TRAFFIC_API_KEY=duplicate\n",
        )
        .unwrap();
        save_keys(&path, "new", "nsw==").unwrap();
        let values = read(&path).unwrap();
        assert_eq!(values["PORT"], "8787");
        assert_eq!(values["QLD_TRAFFIC_API_KEY"], "new");
        assert_eq!(values["NSW_TRAFFIC_API_KEY"], "nsw==");
        assert!(std::fs::read_to_string(&path)
            .unwrap()
            .starts_with("# host config"));
        assert!(save_keys(&path, "x\nPORT=1", "").is_err());
        save_keys(&path, "", "").unwrap();
        assert_eq!(read(&path).unwrap().len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
