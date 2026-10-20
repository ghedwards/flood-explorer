//! Queensland's Water Monitoring Information Portal (WMIP): its gauges'
//! river level (variable 100.00), about an hour behind. The portal sends no
//! CORS headers and asks callers to go easy on it. The query is a JSON
//! object as the whole query string.
//!
//! Data © State of Queensland, CC BY 4.0.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const WMIP: &str = "https://water-monitoring.information.qld.gov.au/cgi/webservice.exe";
pub const ATTRIBUTION: &str = "© State of Queensland (Department of Regional Development, Manufacturing and Water), CC BY 4.0";

/// The network call: URL -> JSON.
pub type FetchJson = dyn Fn(&str) -> Result<Value, String> + Send + Sync;

/// A reading: (ISO 8601 time, level in metres).
pub type Point = (String, f64);

/// Station numbers such as 143001C or 422201F.
pub fn is_site(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[..6].iter().all(u8::is_ascii_digit) && b[6].is_ascii_uppercase()
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let (y, m) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// Milliseconds since 1970 as Queensland time (UTC+10), YYYYMMDDHHMMSS.
pub fn stamp(ms: i64) -> String {
    let t = ms.div_euclid(1000) + 10 * 3600;
    let (y, m, d) = civil_from_days(t.div_euclid(86400));
    let s = t.rem_euclid(86400);
    format!("{:04}{:02}{:02}{:02}{:02}{:02}", y, m, d, s / 3600, s % 3600 / 60, s % 60)
}

/// Milliseconds since 1970 as ISO 8601 UTC.
pub fn iso_utc(ms: i64) -> String {
    let t = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(t.div_euclid(86400));
    let s = t.rem_euclid(86400);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, s / 3600, s % 3600 / 60, s % 60)
}

/// A WMIP time (20261020173616, Queensland time) as ISO 8601.
pub fn time(t: &Value) -> Option<String> {
    let d = match t {
        Value::Number(n) => n.as_u64()?.to_string(),
        Value::String(x) => x.trim().to_string(),
        _ => return None,
    };
    if d.len() != 14 || !d.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}-{}-{}T{}:{}:{}+10:00", &d[0..4], &d[4..6], &d[6..8], &d[8..10], &d[10..12], &d[12..14]))
}

/// Milliseconds since 1970 for "YYYY-MM-DDTHH:MM:SS+10:00" (or Z).
pub fn epoch_ms(t: &str) -> Option<i64> {
    let n = |a: usize, l: usize| -> Option<i64> { t.get(a..a + l)?.parse().ok() };
    let days = days_from_civil(n(0, 4)?, n(5, 2)?, n(8, 2)?);
    let mut s = days * 86400 + n(11, 2)? * 3600 + n(14, 2)? * 60 + n(17, 2)?;
    if let Some(z) = t.get(19..).filter(|z| z.starts_with('+') || z.starts_with('-')) {
        let off = z.get(1..3)?.parse::<i64>().ok()? * 3600 + z.get(4..6).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0) * 60;
        s -= if z.starts_with('-') { -off } else { off };
    }
    Some(s * 1000)
}

/// Percent-encode everything but RFC 3986's unreserved characters.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn query_url(q: &Value) -> String {
    format!("{}?{}", WMIP, encode(&q.to_string()))
}

fn call(fetch: &FetchJson, q: &Value) -> Result<Value, String> {
    let res = fetch(&query_url(q))?;
    match res.get("error_num").and_then(Value::as_i64) {
        Some(0) | None => Ok(res),
        Some(n) => Err(format!("WMIP error {}: {}", n, res.get("error_msg").and_then(Value::as_str).unwrap_or(""))),
    }
}

/// The portal's open stations.
pub fn open_stations(fetch: &FetchJson) -> Result<HashSet<String>, String> {
    let res = call(fetch, &json!({"function": "get_site_list", "version": "1", "params": {"site_list": "GROUP(OPEN_STATIONS)"}}))?;
    let sites = res.pointer("/return/sites").and_then(Value::as_array).ok_or("WMIP: no site list")?;
    Ok(sites.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| is_site(s)).collect())
}

/// Hourly mean levels for some sites over the last `hours`; sites with no
/// usable readings are left out.
pub fn levels(fetch: &FetchJson, sites: &[String], now_ms: i64, hours: i64) -> Result<HashMap<String, Vec<Point>>, String> {
    let q = json!({"function": "get_ts_traces", "version": "2", "params": {
        "site_list": sites.join(","), "datasource": "AT", "varfrom": "100.00", "varto": "100.00",
        "start_time": stamp(now_ms - hours * 3_600_000), "end_time": stamp(now_ms),
        "data_type": "mean", "interval": "hour", "multiplier": "1"}});
    let res = call(fetch, &q)?;
    let mut out = HashMap::new();
    for tr in res.pointer("/return/traces").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let site = tr.get("site").and_then(Value::as_str).unwrap_or("").trim();
        if !is_site(site) {
            continue;
        }
        let mut pts = Vec::new();
        for p in tr.get("trace").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            // quality codes of 200 and up are missing or unusable
            if p.get("q").and_then(Value::as_i64).is_some_and(|q| q >= 200) {
                continue;
            }
            let v = match p.get("v") {
                Some(Value::String(x)) => x.trim().parse::<f64>().ok(),
                Some(Value::Number(n)) => n.as_f64(),
                _ => None,
            };
            if let (Some(v), Some(t)) = (v.filter(|v| v.is_finite()), p.get("t").and_then(time)) {
                pts.push((t, (v * 1000.0).round() / 1000.0));
            }
        }
        if !pts.is_empty() {
            out.insert(site.to_string(), pts);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times() {
        assert_eq!(time(&json!(20261020173616u64)).as_deref(), Some("2026-10-20T17:36:16+10:00"));
        assert_eq!(time(&json!("2026102017")), None);
        let e = epoch_ms("2026-10-20T17:36:16+10:00").unwrap();
        assert_eq!(stamp(e), "20261020173616");
        assert_eq!(stamp(epoch_ms("2026-12-31T14:00:00Z").unwrap()), "20270101000000");
        assert_eq!(iso_utc(e), "2026-10-20T07:36:16Z");
        assert_eq!(epoch_ms("1970-01-01T10:00:00+10:00"), Some(0));
    }

    #[test]
    fn sites_and_encoding() {
        assert!(is_site("143001C"));
        assert!(!is_site("143001c") && !is_site("540198") && !is_site("1430011C"));
        let q = json!({"a": "x,y z"});
        assert_eq!(decode(&encode(&q.to_string())), q.to_string());
        assert!(!encode("{\"a\":1}").contains('{'));
    }
}
