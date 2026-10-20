//! Bureau flood class levels and current flood warnings (was
//! pipeline/fetch_floodinfo.py).
//!
//! Usage: flood floodinfo <out_dir>
//!
//! Writes floodclass.json {station: {station, minor, moderate, major, zero,
//! source}} and warnings.json {fetched, ok, errors, warnings: [{state,
//! title, link, published}]}. The warnings feeds are also read from the
//! Bureau's FTP mirror, asking for the full path without changing
//! directory (the server refuses CWD).

use crate::net::{self, NetErr};
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{Map, Value};
use std::path::Path;

const PAGES: [&str; 8] = [
    "https://www.bom.gov.au/vic/flood/floodclass_north.shtml",
    "https://www.bom.gov.au/vic/flood/floodclass_south.shtml",
    "https://www.bom.gov.au/nsw/flood/floodclass.shtml",
    "https://www.bom.gov.au/qld/flood/floodclass.shtml",
    "https://www.bom.gov.au/sa/flood/floodclass.shtml",
    "https://www.bom.gov.au/wa/flood/floodclass.shtml",
    "https://www.bom.gov.au/tas/flood/floodclass.shtml",
    "https://www.bom.gov.au/nt/flood/floodclass.shtml",
];
const FTP_FWO: &str = "ftp://ftp.bom.gov.au/anon/gen/fwo/";
const FEEDS: [(&str, &str); 7] = [
    ("NSW", "https://www.bom.gov.au/fwo/IDZ00054.warnings_nsw.xml"),
    ("NT", "https://www.bom.gov.au/fwo/IDZ00055.warnings_nt.xml"),
    ("QLD", "https://www.bom.gov.au/fwo/IDZ00056.warnings_qld.xml"),
    ("SA", "https://www.bom.gov.au/fwo/IDZ00057.warnings_sa.xml"),
    ("TAS", "https://www.bom.gov.au/fwo/IDZ00058.warnings_tas.xml"),
    ("VIC", "https://www.bom.gov.au/fwo/IDZ00059.warnings_vic.xml"),
    ("WA", "https://www.bom.gov.au/fwo/IDZ00060.warnings_wa.xml"),
];

pub type HttpText<'a> = &'a dyn Fn(&str) -> R<String>;

/// Fetch text; refusals (4xx) are not retried, FTP once.
pub fn http_text(url: &str) -> R<String> {
    let headers = [
        ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
        ("Accept-Language", "en-AU,en;q=0.8"),
    ];
    let tries = if url.starts_with("ftp") { 1 } else { 2 };
    let mut last = String::new();
    for i in 0..tries {
        match net::get(url, &headers, 20) {
            Ok(r) => return Ok(r.text()),
            Err(NetErr::Status(c, _)) => return Err(format!("{}: HTTP {}", url, c)),
            Err(e) => last = e.to_string(),
        }
        if i + 1 < tries {
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    }
    Err(format!("{}: {}", url, last))
}

/// The text of every table row's cells (like Python's HTMLParser use).
pub fn table_rows(html: &str) -> Vec<Vec<String>> {
    let tag = Regex::new(r"(?is)<(/?)([a-z][a-z0-9]*)\b[^>]*>").unwrap();
    let mut rows = Vec::new();
    let mut row: Option<Vec<String>> = None;
    let mut cell: Option<String> = None;
    let mut pos = 0;
    // text inside <script>/<style> isn't data
    let mut skip_until: Option<String> = None;
    for m in tag.captures_iter(html) {
        let whole = m.get(0).unwrap();
        let text = &html[pos..whole.start()];
        pos = whole.end();
        if skip_until.is_none() {
            if let Some(c) = cell.as_mut() {
                c.push_str(&html_unescape(text));
            }
        }
        let closing = &m[1] == "/";
        let name = m[2].to_lowercase();
        if let Some(s) = &skip_until {
            if closing && &name == s {
                skip_until = None;
            }
            continue;
        }
        if !closing && (name == "script" || name == "style") {
            skip_until = Some(name);
            continue;
        }
        match (closing, name.as_str()) {
            (false, "tr") => row = Some(Vec::new()),
            (false, "td") | (false, "th") if row.is_some() => cell = Some(String::new()),
            (true, "td") | (true, "th") => {
                if let (Some(r), Some(c)) = (row.as_mut(), cell.take()) {
                    r.push(squash(&c));
                }
            }
            (true, "tr") => {
                if let Some(r) = row.take() {
                    rows.push(r);
                }
            }
            _ => {}
        }
    }
    rows
}

/// A flood class level in metres, or None (n/a, flows, blank).
fn level(text: &str) -> Value {
    let t = text.trim().to_lowercase();
    if t.is_empty() || t.contains("m3") || t.contains("/s") || t.contains("n/a") {
        return Value::Null;
    }
    let re = Regex::new(r"^(-?\d+(?:\.\d+)?)\s*m?$").unwrap();
    match re.captures(&t) {
        Some(c) => num(c[1].parse().unwrap()),
        None => Value::Null,
    }
}

pub fn parse_floodclass(html: &str, source: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let mut header: Option<Vec<String>> = None;
    let station_no = Regex::new(r"^\d{4,7}$").unwrap();
    for row in table_rows(html) {
        let low: Vec<String> = row.iter().map(|c| c.to_lowercase()).collect();
        if low.iter().any(|c| c.contains("minor")) && low.iter().any(|c| c.contains("major")) {
            header = Some(low);
            continue;
        }
        let Some(h) = &header else { continue };
        if row.len() < 6 || !station_no.is_match(&row[0]) {
            continue;
        }
        let get = |name: &str| -> String {
            match h.iter().position(|c| c.contains(name)) {
                Some(i) if i < row.len() => row[i].clone(),
                _ => String::new(),
            }
        };
        let st = get("station");
        let rec = obj! {
            "station" => if st.is_empty() { Value::Null } else { Value::from(st) },
            "minor" => level(&get("minor")), "moderate" => level(&get("moderate")), "major" => level(&get("major")),
            "zero" => level(&get("zero")), "source" => source,
        };
        if rec["minor"].is_null() && rec["moderate"].is_null() && rec["major"].is_null() {
            continue;
        }
        out.insert(row[0].parse::<u64>().unwrap().to_string(), rec);
    }
    out
}

pub fn parse_rss(xml: &str, state: &str) -> Vec<Value> {
    let item = Regex::new(r"(?s)<item>(.*?)</item>").unwrap();
    let mut out = Vec::new();
    for m in item.captures_iter(xml) {
        let it = &m[1];
        let get = |tag: &str| -> String {
            let re = Regex::new(&format!(r"(?s)<{0}>(.*?)</{0}>", tag)).unwrap();
            re.captures(it).map(|c| html_unescape(&c[1])).unwrap_or_default().trim().to_string()
        };
        let title = get("title");
        if !title.to_lowercase().contains("flood") {
            continue;
        }
        out.push(obj! {"state" => state, "title" => title, "link" => get("link"), "published" => get("pubDate")});
    }
    out
}

/// The Bureau's flood warnings from its FTP server's CAP files (the
/// website's feeds turn automated requests away): (now, iso now, errors).
pub type CapWarnings<'a> = &'a dyn Fn(i64, &str, &mut Vec<String>) -> Value;

pub fn run(out_dir: &str, http: HttpText, cap: Option<CapWarnings>) -> R<String> {
    let out = Path::new(out_dir);
    std::fs::create_dir_all(out).map_err(err)?;
    let mut classes = Map::new();
    let mut notes = Vec::new();
    for url in PAGES {
        let parts: Vec<&str> = url.split('/').collect();
        let label = format!("{}:{}", parts[3], url.rsplit('/').next().unwrap());
        match http(url) {
            Ok(html) => {
                let got = parse_floodclass(&html, url);
                notes.push(format!("{}={}", label, got.len()));
                classes.extend(got);
            }
            Err(e) => notes.push(format!("{}=none ({})", label, tail(&e, 60))),
        }
    }
    let (mut warnings, mut werr, mut via) = (Vec::new(), Vec::new(), Vec::new());
    for (st, url) in FEEDS {
        let ftp = format!("{}{}", FTP_FWO, url.rsplit('/').next().unwrap());
        let mut last = String::new();
        let mut ok = false;
        for src in [url, ftp.as_str()] {
            match http(src) {
                Ok(t) => {
                    warnings.extend(parse_rss(&t, st));
                    via.push(format!("'{}': '{}'", st, if src.starts_with("ftp") { "ftp" } else { "web" }));
                    ok = true;
                    break;
                }
                Err(e) => last = format!("{}: {}", st, e),
            }
        }
        if !ok {
            werr.push(last);
        }
    }
    if !classes.is_empty() {
        write_json(out.join("floodclass.json"), &Value::Object(classes.clone()))?;
    }
    // the feeds failed: the same warnings from the FTP server's CAP files
    if werr.len() == FEEDS.len() {
        if let Some(cap) = cap {
            let mut e = Vec::new();
            let w = cap(now_s() as i64, &now_iso(), &mut e);
            if w["ok"] == Value::Bool(true) {
                warnings = w["warnings"].as_array().cloned().unwrap_or_default();
                via.push("'all': 'ftp cap'".to_string());
                werr.clear();
            } else {
                werr.extend(e);
            }
        }
    }
    write_json(out.join("warnings.json"), &obj! {"fetched" => now_iso(), "ok" => werr.len() < FEEDS.len(), "errors" => werr.clone(), "warnings" => warnings.clone()})?;
    let via_txt = if via.is_empty() { "none".to_string() } else { format!("{{{}}}", via.join(", ")) };
    let mut msg = format!(
        "Flood info: {} gauges with flood class levels ({}); {} current flood warnings; {} feed errors; feeds via {}",
        classes.len(), notes.join(", "), warnings.len(), werr.len(), via_txt
    );
    for e in werr.iter().take(2) {
        msg.push_str(&format!("\nwarning: {}", e));
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIC: &str = r#"<table>
<tr><th>Bureau No.</th><th>AWRC No.</th><th>Station</th><th>Minor</th><th>Moderate</th><th>Major</th><th>Gauge Zero</th></tr>
<tr><td colspan="7">401 - Upper Murray River Basin</td></tr>
<tr><td>82106</td><td>401204</td><td>Tallandoon</td><td>4.2</td><td>4.9</td><td>5.6</td><td>216.893</td></tr>
<tr><td>572037</td><td>n/a</td><td>Khancoban DS Flow</td><td>114 m3/s</td><td>n/a</td><td>n/a</td><td>n/a</td></tr>
<tr><td>572004</td><td>401549</td><td>Bringenbrong</td><td>3.0</td><td>3.4</td><td>n/a</td><td>n/a</td></tr>
</table>"#;

    const RSS: &str = r#"<rss><channel>
<item><title>Flood Warning for the Mary River</title><link>http://www.bom.gov.au/qld/warnings/flood/maryriver.shtml</link><pubDate>Thu, 15 Oct 2026 03:00:00 GMT</pubDate></item>
<item><title>Severe Thunderstorm Warning &amp; more</title><link>x</link></item>
<item><title>Flood Watch for South East Queensland</title><link>y</link></item>
</channel></rss>"#;

    #[test]
    fn floodclass_table() {
        let got = parse_floodclass(VIC, "vic");
        assert_eq!(got["82106"]["minor"], 4.2);
        assert_eq!(got["82106"]["major"], 5.6);
        assert_eq!(got["82106"]["zero"], 216.893);
        assert_eq!(got["82106"]["station"], "Tallandoon");
        assert!(got.get("572037").is_none(), "flow-only thresholds are skipped");
        assert!(got["572004"]["major"].is_null());
        assert!(got["572004"]["zero"].is_null());
    }

    #[test]
    fn rss_keeps_flood_items() {
        let got = parse_rss(RSS, "QLD");
        let titles: Vec<&str> = got.iter().map(|w| w["title"].as_str().unwrap()).collect();
        assert_eq!(titles, ["Flood Warning for the Mary River", "Flood Watch for South East Queensland"]);
        assert_eq!(got[0]["state"], "QLD");
    }

    #[test]
    fn writes_files_and_survives_failures() {
        let d = std::env::temp_dir().join(format!("fi-{}", std::process::id()));
        let fake = |url: &str| -> R<String> {
            if url.contains("floodclass_north") {
                Ok(VIC.into())
            } else if url.contains("IDZ00056") {
                Ok(RSS.into())
            } else {
                Err("unreachable".into())
            }
        };
        run(d.to_str().unwrap(), &fake, None).unwrap();
        let classes = read_json(d.join("floodclass.json")).unwrap();
        let warn = read_json(d.join("warnings.json")).unwrap();
        assert!(classes.get("82106").is_some());
        assert_eq!(warn["warnings"].as_array().unwrap().len(), 2);
        assert_eq!(warn["ok"], true);
        let _ = std::fs::remove_dir_all(d);
    }
}
