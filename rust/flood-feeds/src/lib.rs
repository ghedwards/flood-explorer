//! Live feeds shared by the data build (flood-pipeline) and the live data
//! broker (flood-broker): river and dam readings from the Bureau of
//! Meteorology's Water Data Online (KiWIS), and Queensland's own gauges from
//! its Water Monitoring Information Portal.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub type R<T> = Result<T, String>;

pub const KIWIS: &str = "https://www.bom.gov.au/waterdata/services";
pub const DAILY: &str = "DMQaQc.Merged.DailyMean.24HR";
/// Hourly means: as recent as the raw readings (Water Data Online runs
/// about a day behind either way) at a quarter of the data; the latest one
/// is the "level now" for river gauges (daily means stay as the history).
pub const HOURLY: &str = "DMQaQc.Merged.HourlyMean.HR";
/// Queensland's Water Monitoring Information Portal: its own gauges' stage,
/// about an hour behind (Water Data Online is about a day behind). The
/// query is a JSON object as the whole query string.
pub const WMIP: &str = "https://water-monitoring.information.qld.gov.au/cgi/webservice.exe";
pub const WMIP_ATTRIBUTION: &str = "© State of Queensland (Department of Regional Development, Manufacturing and Water), CC BY 4.0";

/// The network call: (url, query parameters) -> JSON.
pub type HttpJson<'a> = &'a dyn Fn(&str, &[(String, String)]) -> R<Value>;

/// Build a JSON object from pairs, keeping their order.
macro_rules! obj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = serde_json::Map::new();
        $( m.insert(($k).to_string(), serde_json::Value::from($v)); )*
        serde_json::Value::Object(m)
    }};
}

fn p(k: &str, v: impl ToString) -> (String, String) {
    (k.to_string(), v.to_string())
}

pub fn arr(v: Option<&Value>) -> &[Value] {
    v.and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

/// Python's str() of a JSON scalar.
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => if *b { "True".into() } else { "False".into() },
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                let x = n.as_f64().unwrap_or(f64::NAN);
                let s = format!("{}", x);
                if s.contains('.') || s.contains('e') || !x.is_finite() { s } else { format!("{}.0", s) }
            }
        }
        other => other.to_string(),
    }
}

/// A string field, or "".
pub fn s_or_empty(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(x) => py_str(x),
    }
}

/// Correctly rounded to n decimals.
pub fn round_to(x: f64, n: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{:.*}", n, x).parse().unwrap_or(x)
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

pub fn kiwis_with(http: HttpJson, params: &[(String, String)]) -> R<Value> {
    let mut all = vec![p("service", "kisters"), p("type", "QueryServices"), p("format", "json")];
    for (k, v) in params {
        if let Some(x) = all.iter_mut().find(|(a, _)| a == k) {
            x.1 = v.clone();
        } else {
            all.push((k.clone(), v.clone()));
        }
    }
    http(KIWIS, &all)
}

/// Pairs for a KiWIS query.
pub fn kp(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// A KiWIS table ([[header...], [row...], ...]): the column index of a name.
pub fn col(header: &Value, name: &str) -> Option<usize> {
    header.as_array()?.iter().position(|h| h.as_str() == Some(name))
}

pub fn timeseries_ids(http: HttpJson, parameter: &str, ts_name: &str, errors: &mut Vec<String>) -> Vec<(String, String)> {
    let rows = match kiwis_with(http, &kp(&[("request", "getTimeseriesList"), ("parametertype_name", parameter), ("ts_name", ts_name), ("returnfields", "station_no,ts_id")])) {
        Ok(r) => r,
        Err(e) => {
            errors.push(format!("timeseries list ({}): {}", parameter, e));
            return Vec::new();
        }
    };
    let rows = match rows.as_array() {
        Some(r) if !r.is_empty() => r,
        _ => return Vec::new(),
    };
    let (Some(i_st), Some(i_ts)) = (col(&rows[0], "station_no"), col(&rows[0], "ts_id")) else {
        return Vec::new();
    };
    // a dict in Python: the last row for a station wins, first position kept
    let mut out: Vec<(String, String)> = Vec::new();
    for r in &rows[1..] {
        let st = py_str(&r[i_st]).trim().to_string();
        let ts = py_str(&r[i_ts]);
        if let Some(x) = out.iter_mut().find(|x| x.0 == st) {
            x.1 = ts;
        } else {
            out.push((st, ts));
        }
    }
    out
}

pub fn latest_values(http: HttpJson, ids: &[String], period: &str, errors: &mut Vec<String>) -> HashMap<String, Vec<Value>> {
    let mut out = HashMap::new();
    for (bi, chunk) in ids.chunks(50).enumerate() {
        let res = match kiwis_with(http, &kp(&[("request", "getTimeseriesValues"), ("ts_id", &chunk.join(",")), ("period", period), ("returnfields", "Timestamp,Value")])) {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("values batch {}: {}", bi, e));
                continue;
            }
        };
        let entries = match &res {
            Value::Array(a) => a.clone(),
            other => vec![other.clone()],
        };
        for entry in entries {
            if !entry.is_object() {
                continue;
            }
            let vals: Vec<Value> = arr(entry.get("data")).iter().filter(|r| !r[1].is_null()).map(|r| json!([r[0], r[1]])).collect();
            match entry.get("ts_id") {
                Some(t) if !t.is_null() && !vals.is_empty() => {
                    out.insert(py_str(t), vals);
                }
                _ => {}
            }
        }
    }
    out
}

/// Seconds since 1970 for a KiWIS timestamp ("2026-10-19T18:00:00.000+10:00"
/// or "...Z"), for comparing readings from different states' time zones.
pub fn ts_epoch(t: &str) -> Option<i64> {
    let b = t.as_bytes();
    if b.len() < 19 { return None; }
    let num = |a: usize, n: usize| -> Option<i64> { std::str::from_utf8(&b[a..a + n]).ok()?.parse().ok() };
    let (y, mo, d, h, mi, s) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    // days from civil (Howard Hinnant)
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut off = 0i64;
    if let Some(p) = t[19..].find(['+', '-']) {
        let z = &t[19 + p..];
        let sign = if z.starts_with('-') { -1 } else { 1 };
        let hh: i64 = z.get(1..3)?.parse().ok()?;
        let mm: i64 = z.get(4..6).and_then(|x| x.parse().ok()).unwrap_or(0);
        off = sign * (hh * 3600 + mm * 60);
    }
    Some(days * 86400 + h * 3600 + mi * 60 + s - off)
}

pub fn wmip(http: HttpJson, q: &Value) -> R<Value> {
    let res = http(&format!("{}?{}", WMIP, encode(&q.to_string())), &[])?;
    match res.get("error_num").and_then(|e| e.as_i64()) {
        Some(0) | None => Ok(res),
        Some(n) => Err(format!("WMIP error {}: {}", n, s_or_empty(res.get("error_msg")))),
    }
}

/// A WMIP time (20261020173616, Queensland time) as ISO 8601.
pub fn wmip_time(t: &Value) -> Option<String> {
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

/// Seconds since 1970 as Queensland's YYYYMMDDHHMMSS.
pub fn wmip_stamp(epoch: i64) -> String {
    let t = epoch + 10 * 3600;
    let (days, secs) = (t.div_euclid(86400), t.rem_euclid(86400));
    // civil from days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{:04}{:02}{:02}{:02}{:02}{:02}", y, m, d, secs / 3600, secs % 3600 / 60, secs % 60)
}

/// The latest hourly stage (variable 100.00) from Queensland's portal for
/// the gauges it runs: station -> [[time, level]...], the last day or so.
pub fn qld_realtime(http: HttpJson, stations: &HashSet<String>, now_epoch: i64, errors: &mut Vec<String>) -> HashMap<String, Vec<Value>> {
    let mut out = HashMap::new();
    let open = match wmip(http, &json!({"function": "get_site_list", "version": "1", "params": {"site_list": "GROUP(OPEN_STATIONS)"}})) {
        Ok(r) => r,
        Err(e) => {
            errors.push(format!("Queensland site list: {}", e));
            return out;
        }
    };
    let mut sites: Vec<String> = arr(open.pointer("/return/sites")).iter().filter_map(|x| x.as_str()).map(|x| x.trim().to_string()).filter(|x| stations.contains(x)).collect();
    sites.sort();
    sites.dedup();
    let (from, to) = (wmip_stamp(now_epoch - 30 * 3600), wmip_stamp(now_epoch));
    for (bi, chunk) in sites.chunks(25).enumerate() {
        let q = json!({"function": "get_ts_traces", "version": "2", "params": {"site_list": chunk.join(","), "datasource": "AT", "varfrom": "100.00", "varto": "100.00",
            "start_time": from, "end_time": to, "data_type": "mean", "interval": "hour", "multiplier": "1"}});
        let res = match wmip(http, &q) {
            Ok(r) => r,
            Err(e) => {
                errors.push(format!("Queensland batch {}: {}", bi, e));
                continue;
            }
        };
        for tr in arr(res.pointer("/return/traces")) {
            let Some(site) = tr.get("site").and_then(|x| x.as_str()) else { continue };
            // quality codes of 200 and up are missing or unusable
            let pts: Vec<Value> = arr(tr.get("trace"))
                .iter()
                .filter(|p| p.get("q").and_then(|q| q.as_i64()).is_none_or(|q| q < 200))
                .filter_map(|p| {
                    let v = match p.get("v")? {
                        Value::String(x) => x.trim().parse::<f64>().ok()?,
                        Value::Number(n) => n.as_f64()?,
                        _ => return None,
                    };
                    Some(json!([wmip_time(p.get("t")?)?, round_to(v, 3)]))
                })
                .filter(|p| p[1].as_f64().is_some_and(f64::is_finite))
                .collect();
            if !pts.is_empty() {
                out.insert(site.trim().to_string(), pts);
            }
        }
    }
    out
}

/// Readings for some stations: {station: {unit, series (daily, last 10),
/// latest, latestKind}}. River levels (`hourly`) take the newest hourly mean,
/// and Queensland's portal where it is newer still.
pub fn readings_for(http: HttpJson, wanted: &HashSet<String>, parameter: &str, unit: &str, hourly: bool, now_s: i64, errors: &mut Vec<String>) -> Value {
    let ts: Vec<(String, String)> = timeseries_ids(http, parameter, DAILY, errors).into_iter().filter(|(st, _)| wanted.contains(st)).collect();
    let ids: Vec<String> = ts.iter().map(|x| x.1.clone()).collect();
    let vals = if ts.is_empty() { HashMap::new() } else { latest_values(http, &ids, "P10D", errors) };
    // the latest hourly mean, where there is one, when it's newer than the daily
    let mut recent: HashMap<String, Value> = HashMap::new();
    if hourly && !ts.is_empty() {
        let hts: Vec<(String, String)> = timeseries_ids(http, parameter, HOURLY, errors).into_iter().filter(|(st, _)| wanted.contains(st)).collect();
        let hids: Vec<String> = hts.iter().map(|x| x.1.clone()).collect();
        let hvals = if hts.is_empty() { HashMap::new() } else { latest_values(http, &hids, "P3D", errors) };
        for (st, tid) in hts {
            if let Some(last) = hvals.get(&tid).and_then(|v| v.last()) {
                recent.insert(st, last.clone());
            }
        }
    }
    let mut out = Map::new();
    let live = if hourly { qld_realtime(http, wanted, now_s, errors) } else { HashMap::new() };
    for (st, tid) in ts {
        if let Some(series) = vals.get(&tid) {
            let last10 = series[series.len().saturating_sub(10)..].to_vec();
            let daily = series[series.len() - 1].clone();
            let newer = |r: &Value| ts_epoch(r[0].as_str().unwrap_or("")).zip(ts_epoch(daily[0].as_str().unwrap_or(""))).is_some_and(|(a, b)| a > b);
            let (latest, kind) = match recent.get(&st) {
                Some(r) if newer(r) => (r.clone(), "hourly"),
                _ => (daily, "daily"),
            };
            out.insert(st, obj! {"unit" => unit, "series" => last10, "latest" => latest, "latestKind" => kind});
        }
    }
    // Queensland's own gauges: the portal's latest hour, when it's newer
    for (st, pts) in live {
        let last = pts[pts.len() - 1].clone();
        let at = |r: &Value| ts_epoch(r[0].as_str().unwrap_or(""));
        match out.get_mut(&st) {
            Some(e) => {
                if at(&last).zip(at(&e["latest"])).is_some_and(|(a, b)| a > b) {
                    e["latest"] = last;
                    e["latestKind"] = json!("realtime");
                }
            }
            None => {
                out.insert(st, obj! {"unit" => unit, "series" => json!([]), "latest" => last, "latestKind" => "realtime"});
            }
        }
    }
    Value::Object(out)
}


/// Every reading the map shows: river levels (with Queensland's live ones)
/// and dam volumes, as readings.json.
pub fn readings(http: HttpJson, level: &HashSet<String>, storage: &HashSet<String>, now_s: i64, errors: &mut Vec<String>) -> Value {
    obj! {
        "level" => readings_for(http, level, "Water Course Level", "m", true, now_s, errors),
        "storage" => readings_for(http, storage, "Storage Volume", "ML", false, now_s, errors),
        "series" => DAILY,
    }
}

/// How many river levels came from Queensland's portal.
pub fn realtime_count(readings: &Value) -> usize {
    readings["level"].as_object().map_or(0, |o| o.values().filter(|r| r["latestKind"] == "realtime").count())
}
