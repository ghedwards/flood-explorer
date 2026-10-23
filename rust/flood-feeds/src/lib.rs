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
    // the hourly means (last three days), where there are some: the latest
    // is the level now when it's newer than the daily, and they give the rise
    let mut recent: HashMap<String, Vec<Value>> = HashMap::new();
    if hourly && !ts.is_empty() {
        let hts: Vec<(String, String)> = timeseries_ids(http, parameter, HOURLY, errors).into_iter().filter(|(st, _)| wanted.contains(st)).collect();
        let hids: Vec<String> = hts.iter().map(|x| x.1.clone()).collect();
        let hvals = if hts.is_empty() { HashMap::new() } else { latest_values(http, &hids, "P3D", errors) };
        for (st, tid) in hts {
            if let Some(v) = hvals.get(&tid).filter(|v| !v.is_empty()) {
                recent.insert(st, v.clone());
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
            let (latest, kind) = match recent.get(&st).and_then(|h| h.last()) {
                Some(r) if newer(r) => (r.clone(), "hourly"),
                _ => (daily, "daily"),
            };
            let mut e = obj! {"unit" => unit, "series" => last10, "latest" => latest, "latestKind" => kind};
            if kind == "hourly" {
                add_rise(&mut e, &recent[&st]);
            }
            out.insert(st, e);
        }
    }
    apply_live(&mut out, live, unit);
    Value::Object(out)
}

/// Queensland's own gauges: the portal's latest hour, where it's newer than
/// what the readings have (or the gauge isn't in them).
pub fn apply_live(out: &mut Map<String, Value>, live: HashMap<String, Vec<Value>>, unit: &str) {
    for (st, pts) in live {
        let last = pts[pts.len() - 1].clone();
        let at = |r: &Value| ts_epoch(r[0].as_str().unwrap_or(""));
        match out.get_mut(&st) {
            Some(e) => {
                if at(&last).zip(at(&e["latest"])).is_some_and(|(a, b)| a > b) {
                    e["latest"] = last;
                    e["latestKind"] = json!("realtime");
                    add_rise(e, &pts);
                }
            }
            None => {
                let mut e = obj! {"unit" => unit, "series" => json!([]), "latest" => last, "latestKind" => "realtime"};
                add_rise(&mut e, &pts);
                out.insert(st, e);
            }
        }
    }
}


/// How much a level has changed over the last `hours`, from hourly points
/// [[time, level]...] (oldest first): the latest level less the one at or
/// just before that time, if the points reach back that far (with an hour's
/// slack for a missing reading).
pub fn rise_over(points: &[Value], hours: i64) -> Option<f64> {
    let last = points.last()?;
    let (t1, v1) = (ts_epoch(last[0].as_str()?)?, last[1].as_f64()?);
    let want = t1 - hours * 3600;
    let then = points.iter().rev().find(|p| p[0].as_str().and_then(ts_epoch).is_some_and(|t| t <= want))?;
    let (t0, v0) = (ts_epoch(then[0].as_str()?)?, then[1].as_f64()?);
    if want - t0 > 3600 {
        return None;
    }
    Some(round_to(v1 - v0, 2))
}

/// Rises worth a closer look: fast (3 hours) or sustained (24 hours).
pub const RISE_3H_M: f64 = 0.3;
pub const RISE_24H_M: f64 = 1.0;
/// Heavy rain forecast near a gauge (mm in the next 24 or 72 hours).
pub const RAIN_24H_MM: f64 = 50.0;
pub const RAIN_72H_MM: f64 = 100.0;
/// Heavy rain observed at a rain gauge in the last 24 hours (mm).
pub const RAIN_OBS_24H_MM: f64 = 100.0;
/// A sea this much above the predicted tide (storm surge, metres).
pub const SURGE_M: f64 = 0.3;

/// Does the last day of hourly levels rise and fall with the tide? (At
/// least three turns of 0.15 m or more: a river doesn't do that in a day.)
pub fn looks_tidal(hourly: &[Value]) -> bool {
    let Some(t1) = hourly.last().and_then(|p| p[0].as_str()).and_then(ts_epoch) else { return false };
    let v: Vec<f64> = hourly.iter().filter(|p| p[0].as_str().and_then(ts_epoch).is_some_and(|t| t > t1 - 86_400)).filter_map(|p| p[1].as_f64()).collect();
    if v.len() < 8 {
        return false;
    }
    // turning points that stand out by at least 0.15 m
    let (mut turns, mut dir, mut ext) = (0, 0i8, v[0]);
    for &x in &v[1..] {
        match dir {
            0 => {
                if (x - ext).abs() >= 0.15 {
                    dir = if x > ext { 1 } else { -1 };
                    ext = x;
                }
            }
            1 => {
                if x > ext {
                    ext = x;
                } else if ext - x >= 0.15 {
                    turns += 1;
                    dir = -1;
                    ext = x;
                }
            }
            _ => {
                if x < ext {
                    ext = x;
                } else if x - ext >= 0.15 {
                    turns += 1;
                    dir = 1;
                    ext = x;
                }
            }
        }
    }
    turns >= 3
}

fn add_rise(e: &mut Value, hourly: &[Value]) {
    if looks_tidal(hourly) {
        e["tidal"] = json!(true);
    }
    if let Some(r) = rise_over(hourly, 3) {
        e["rise3h"] = json!(r);
    }
    if let Some(r) = rise_over(hourly, 24) {
        e["rise24h"] = json!(r);
    }
}

/// Things worth a closer look, most pressing first: river gauges rising
/// fast or with heavy rain forecast, and tide gauges with a storm surge.
/// [{kind: "river"|"sea", station, level, at, why: [...], score}].
pub fn watch_list(doc: &Value) -> Value {
    let mut w: Vec<(f64, Value)> = Vec::new();
    if let Some(lv) = doc["level"].as_object() {
        for (st, r) in lv {
            let mut why = Vec::new();
            let mut score = 0.0f64;
            // a tidal river rises and falls twice a day: its rises aren't news
            let tidal = r["tidal"].as_bool() == Some(true);
            let (r3, r24) = if tidal { (None, None) } else { (r["rise3h"].as_f64(), r["rise24h"].as_f64()) };
            if let Some(x) = r3.filter(|x| *x >= RISE_3H_M) {
                why.push(format!("up {:.2} m in 3 hours", x));
                score = score.max(x / RISE_3H_M);
            }
            if let Some(x) = r24.filter(|x| *x >= RISE_24H_M) {
                why.push(format!("up {:.2} m in 24 hours", x));
                score = score.max(x / RISE_24H_M);
            }
            if let Some(rain) = doc["rain"].get(st) {
                let (a, b) = (rain[0].as_f64().unwrap_or(0.0), rain[1].as_f64().unwrap_or(0.0));
                if a >= RAIN_24H_MM || b >= RAIN_72H_MM {
                    why.push(format!("{:.0} mm of rain forecast nearby in 24 hours, {:.0} mm in 72", a, b));
                    score = score.max((a / RAIN_24H_MM).max(b / RAIN_72H_MM) * 0.8);
                }
            }
            if !why.is_empty() {
                w.push((score, json!({"kind": "river", "station": st, "level": r["latest"][1], "at": r["latest"][0], "rise3h": r["rise3h"], "rise24h": r["rise24h"], "why": why})));
            }
        }
    }
    if let Some(sea) = doc["sea"].as_object() {
        for (site, x) in sea {
            // the surge: the residual less this gauge's usual residual (some
            // sites' predictions sit a constant amount off)
            if let Some(su) = x["surge"].as_f64().filter(|r| *r >= SURGE_M) {
                w.push((su / SURGE_M, json!({"kind": "sea", "station": site, "name": x["name"], "level": x["level"], "at": x["at"],
                    "why": [format!("sea {:.2} m higher above the predicted tide than usual", su)]})));
            }
        }
    }
    // gauges the Bureau has at minor, moderate or major flooding now
    if let Some(fc) = doc["floodclass"].as_object() {
        for (st, g) in fc {
            let rank = class_rank(g["class"].as_str().unwrap_or(""));
            if rank == 0 {
                continue;
            }
            let tend = g["tendency"].as_str().unwrap_or("");
            w.push(((rank as f64) * 6.0 + 6.0, json!({"kind": "flood", "station": st, "name": g["name"], "level": g["level"], "at": g["at"],
                "why": [format!("{} flooding now{} (Bureau of Meteorology)", g["class"].as_str().unwrap_or(""), if tend.is_empty() { String::new() } else { format!(", {}", tend) })]})));
        }
    }
    // rain gauges that have recorded heavy rain in the last 24 hours
    if let Some(ro) = doc["rainObs"].as_object() {
        for (st, x) in ro {
            if let Some(mm) = x["mm24h"].as_f64().filter(|m| *m >= RAIN_OBS_24H_MM) {
                let mut why = format!("{:.0} mm of rain recorded in the last 24 hours", mm);
                if let Some(m6) = x["mm6h"].as_f64().filter(|m| *m > 0.0) {
                    why.push_str(&format!(" ({:.0} mm in the last 6 hours)", m6));
                }
                w.push(((mm / RAIN_OBS_24H_MM) * 1.5, json!({
                    "kind": "rainObs", "station": st, "name": x["name"],
                    "lat": x["lat"], "lon": x["lon"], "mm24h": mm, "why": [why],
                })));
            }
        }
    }
    // officially closed major-road events, whatever the reason
    for item in doc["roads"]["items"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        if item["closed"].as_bool() == Some(true) && item["major"].as_bool() == Some(true) {
            let road = item["road"].as_str().unwrap_or("Road");
            let wh = item["where"].as_str().unwrap_or("");
            let name = if wh.is_empty() { road.to_string() } else { format!("{} ({})", road, wh) };
            let desc = item["desc"].as_str().unwrap_or(item["type"].as_str().unwrap_or("Closed"));
            w.push((4.0, json!({
                "kind": "road", "station": item["id"], "name": name,
                "lat": item["lat"], "lon": item["lon"], "at": item["updated"],
                "link": item["link"], "why": [format!("{} ({})", desc, item["state"].as_str().unwrap_or(""))],
            })));
        }
    }
    // the Bureau's own warnings come first
    for x in doc["warnings"]["warnings"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let sev = x["severity"].as_str().unwrap_or("");
        let score = match sev { "Extreme" | "Major" => 30.0, "Severe" | "Moderate" => 20.0, _ => 10.0 };
        let label = match sev { "" | "Unknown" => "Flood warning".to_string(), s => format!("{} flood warning", s) };
        w.push((score, json!({"kind": "warning", "station": x["id"], "name": x["title"], "at": x["published"], "why": [format!("{} (Bureau of Meteorology)", label)], "link": x["link"]})));
    }
    w.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Value::Array(w.into_iter().map(|(sc, mut v)| { v["score"] = json!(round_to(sc, 2)); v }).collect())
}

/// What puts something on the watch list, for the map to explain.
pub fn watch_rule() -> String {
    format!("a current Bureau flood warning; a gauge the Bureau has at minor flooding or above; a major road officially closed by flooding; river up at least {} m in 3 hours or {} m in 24 hours; at least {:.0} mm of rain recorded in 24 hours; at least {} mm of rain forecast near the gauge in 24 hours or {} mm in 72; sea at least {} m above the predicted tide",
        RISE_3H_M, RISE_24H_M, RAIN_OBS_24H_MM, RAIN_24H_MM, RAIN_72H_MM, SURGE_M)
}

/* ---------------------------------------------------------- the sea */

/// Queensland's storm tide gauges: the last 7 days of 10-minute readings
/// for every site, with the predicted tide and the residual (surge).
pub const STORM_TIDE_CSV: &str = "https://apps.des.qld.gov.au/data-sets/storm-tides/tide-7dayopdata.csv";
pub const STORM_TIDE_ATTRIBUTION: &str = "Storm tide data © State of Queensland (Department of the Environment, Tourism, Science and Innovation), CC BY 4.0";

/// Site, Seconds, DateTime, Water Level, Prediction, Residual, Latitude,
/// Longitude (-99 = missing). Per site: the latest good reading, the largest
/// residual in the last 24 hours, and a half-hourly series for that day.
pub fn parse_storm_tide(csv: &str) -> Value {
    struct Row { secs: i64, time: String, level: f64, pred: f64, resid: f64 }
    let mut sites: std::collections::BTreeMap<String, (f64, f64, Vec<Row>)> = std::collections::BTreeMap::new();
    for line in csv.lines() {
        let f: Vec<&str> = line.split(',').map(str::trim).collect();
        if f.len() < 8 {
            continue;
        }
        let (Ok(secs), Ok(level), Ok(pred), Ok(resid), Ok(lat), Ok(lon)) = (f[1].parse::<i64>(), f[3].parse::<f64>(), f[4].parse::<f64>(), f[5].parse::<f64>(), f[6].parse::<f64>(), f[7].parse::<f64>()) else {
            continue; // the header and title lines
        };
        let e = sites.entry(f[0].to_string()).or_insert((lat, lon, Vec::new()));
        e.2.push(Row { secs, time: f[2].to_string(), level, pred, resid });
    }
    let ok = |x: f64| x > -90.0 && x.is_finite();
    let mut out = Map::new();
    for (site, (lat, lon, mut rows)) in sites {
        rows.sort_by_key(|r| r.secs);
        let Some(last) = rows.iter().rev().find(|r| ok(r.level) && ok(r.pred)) else { continue };
        let day: Vec<&Row> = rows.iter().filter(|r| r.secs > last.secs - 86_400).collect();
        let max_res = day.iter().filter(|r| ok(r.resid)).map(|r| r.resid).fold(f64::NEG_INFINITY, f64::max);
        // this gauge's usual residual over the week (the median)
        let mut all: Vec<f64> = rows.iter().filter(|r| ok(r.resid)).map(|r| r.resid).collect();
        all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let normal = if all.len() >= 36 { Some(all[all.len() / 2]) } else { None };
        let resid = if ok(last.resid) { last.resid } else { last.level - last.pred };
        let series: Vec<Value> = day.iter().filter(|r| r.secs % 1800 == 0 && ok(r.level)).map(|r| json!([format!("{}:00+10:00", r.time), round_to(r.level, 3), if ok(r.pred) { json!(round_to(r.pred, 3)) } else { Value::Null }])).collect();
        out.insert(site.clone(), json!({
            "name": site, "lat": lat, "lon": lon, "at": format!("{}:00+10:00", last.time),
            "level": round_to(last.level, 3), "predicted": round_to(last.pred, 3),
            "residual": round_to(resid, 3),
            "residualNormal": normal.map(|n| round_to(n, 3)),
            "surge": normal.map(|n| round_to(resid - n, 3)),
            "residualMax24h": if max_res.is_finite() { json!(round_to(max_res, 3)) } else { Value::Null },
            "series": series,
        }));
    }
    Value::Object(out)
}

/* --------------------------------------------------- rain forecasts */

pub const OPEN_METEO: &str = "https://api.open-meteo.com/v1/forecast";
pub const RAIN_ATTRIBUTION: &str = "Rain forecasts: Open-Meteo.com (CC BY 4.0)";
/// Open-Meteo's free tier allows 10,000 calls a day and 600 a minute;
/// each location counts, so gauges share grid cells and calls are paced.
pub const RAIN_MAX_POINTS: usize = 600;

/// Group gauges into grid cells, coarsening the grid until there are at most
/// `max` cells: (cell centres as (lat, lon), gauge -> cell index).
pub fn rain_cells(coords: &[(String, f64, f64)], max: usize) -> (Vec<(f64, f64)>, HashMap<String, usize>) {
    let mut step = 0.25;
    loop {
        let mut cells: Vec<(f64, f64)> = Vec::new();
        let mut index: HashMap<(i64, i64), usize> = HashMap::new();
        let mut of = HashMap::new();
        for (st, lon, lat) in coords {
            let k = ((lat / step).floor() as i64, (lon / step).floor() as i64);
            let i = *index.entry(k).or_insert_with(|| {
                cells.push((round_to((k.0 as f64 + 0.5) * step, 3), round_to((k.1 as f64 + 0.5) * step, 3)));
                cells.len() - 1
            });
            of.insert(st.clone(), i);
        }
        if cells.len() <= max || step > 4.0 {
            return (cells, of);
        }
        step *= 1.5;
    }
}

/// Rain forecast for the next 24 and 72 hours (mm) at each cell, in
/// batches of 100 locations, pausing between batches.
pub fn rain_forecast(http: HttpJson, cells: &[(f64, f64)], now_s: i64, pause: &dyn Fn(), time_left: &dyn Fn() -> bool, errors: &mut Vec<String>) -> Vec<Option<(f64, f64)>> {
    let mut out = vec![None; cells.len()];
    let chunks: Vec<&[(f64, f64)]> = cells.chunks(100).collect();
    // every batch once, then the ones that failed once more (a failed
    // connection is usually momentary)
    let mut order: Vec<usize> = (0..chunks.len()).collect();
    let mut failed: Vec<usize> = Vec::new();
    let mut retried = false;
    let mut k = 0;
    while k < order.len() {
        let bi = order[k];
        k += 1;
        if k > 1 {
            pause();
        }
        if !time_left() {
            errors.push(format!("rain forecast: out of time with {} of {} batches left", order.len() - k + 1 + failed.len(), chunks.len()));
            break;
        }
        let chunk = chunks[bi];
        let lat = chunk.iter().map(|c| c.0.to_string()).collect::<Vec<_>>().join(",");
        let lon = chunk.iter().map(|c| c.1.to_string()).collect::<Vec<_>>().join(",");
        let res = match http(OPEN_METEO, &[p("latitude", lat), p("longitude", lon), p("hourly", "precipitation"), p("forecast_days", 4), p("timezone", "UTC"), p("timeformat", "unixtime")]) {
            Ok(r) => r,
            Err(e) => {
                if retried {
                    errors.push(format!("rain forecast batch {} (second try): {}", bi, e));
                } else {
                    failed.push(bi);
                }
                if k == order.len() && !retried && !failed.is_empty() {
                    order.append(&mut failed);
                    retried = true;
                }
                continue;
            }
        };
        if k == order.len() && !retried && !failed.is_empty() {
            order.append(&mut failed);
            retried = true;
        }
        let list: Vec<Value> = match res {
            Value::Array(a) => a,
            one => vec![one],
        };
        for (j, x) in list.iter().enumerate().take(chunk.len()) {
            let times = arr(x.pointer("/hourly/time"));
            let rain = arr(x.pointer("/hourly/precipitation"));
            let sum = |hours: i64| -> f64 {
                times.iter().zip(rain).filter(|(t, _)| t.as_i64().is_some_and(|t| t >= now_s - 3600 && t < now_s + hours * 3600)).map(|(_, v)| v.as_f64().unwrap_or(0.0)).sum()
            };
            if !times.is_empty() {
                out[bi * 100 + j] = Some((round_to(sum(24), 1), round_to(sum(72), 1)));
            }
        }
    }
    out
}

/// Every reading the map shows: river levels (with Queensland's live ones)
/// and dam volumes, as readings.json.
pub fn readings(http: HttpJson, level: &HashSet<String>, storage: &HashSet<String>, now_s: i64, errors: &mut Vec<String>) -> Value {
    let mut doc = obj! {
        "level" => readings_for(http, level, "Water Course Level", "m", true, now_s, errors),
        "storage" => readings_for(http, storage, "Storage Volume", "ML", false, now_s, errors),
        "series" => DAILY,
    };
    doc["watch"] = watch_list(&doc);
    doc["watchRule"] = json!(watch_rule());
    doc
}

/// How many river levels came from Queensland's portal.
pub fn realtime_count(readings: &Value) -> usize {
    readings["level"].as_object().map_or(0, |o| o.values().filter(|r| r["latestKind"] == "realtime").count())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hourly(levels: &[f64]) -> Vec<Value> {
        levels.iter().enumerate().map(|(i, v)| json!([format!("2026-10-20T{:02}:00:00.000+10:00", i), v])).collect()
    }

    #[test]
    fn rises() {
        let pts = hourly(&[1.0, 1.0, 1.1, 1.2, 1.4, 1.9]);
        assert_eq!(rise_over(&pts, 3), Some(0.8), "1.9 now less 1.1 three hours before");
        assert_eq!(rise_over(&pts, 24), None, "doesn't reach back a day");
        let day: Vec<f64> = (0..24).map(|i| 2.0 + i as f64 * 0.1).collect();
        assert_eq!(rise_over(&hourly(&day), 3), Some(0.3));
        // a missing hour is fine, a long gap isn't
        let gap = vec![json!(["2026-10-20T00:00:00+10:00", 1.0]), json!(["2026-10-20T05:00:00+10:00", 2.0])];
        assert_eq!(rise_over(&gap, 3), None);
        let one = vec![json!(["2026-10-20T01:00:00+10:00", 1.0]), json!(["2026-10-20T05:00:00+10:00", 2.0])];
        assert_eq!(rise_over(&one, 3), Some(1.0));
    }

    #[test]
    fn watch_list_with_reasons() {
        let doc = json!({
            "level": {
                "A": {"latest": ["t", 3.0], "rise3h": 0.6, "rise24h": 1.2, "latestKind": "realtime"},
                "B": {"latest": ["t", 1.0], "rise3h": 0.1, "rise24h": 1.6, "latestKind": "hourly"},
                "C": {"latest": ["t", 1.0], "rise3h": 0.1, "rise24h": 0.2, "latestKind": "hourly"},
                "D": {"latest": ["t", 1.0], "latestKind": "daily"},
            },
            "rain": {"D": [80.0, 140.0], "C": [5.0, 10.0]},
            "sea": {"whyteislandnx": {"name": "whyteislandnx", "level": 2.1, "at": "t", "residual": 0.45, "surge": 0.45}, "x": {"residual": 1.7, "surge": 0.05}},
        });
        let w = watch_list(&doc);
        let ids: Vec<&str> = w.as_array().unwrap().iter().map(|x| x["station"].as_str().unwrap()).collect();
        // measured rises and surges rank above a forecast of rain
        assert_eq!(ids, ["A", "B", "whyteislandnx", "D"]);
        assert_eq!(w[0]["why"], json!(["up 0.60 m in 3 hours", "up 1.20 m in 24 hours"]));
        assert_eq!(w[2]["kind"], "sea");
        assert!(w[3]["why"][0].as_str().unwrap().contains("80 mm of rain"));
    }

    #[test]
    fn storm_tide_file() {
        let csv = "Tide Data provided @ 07:45hrs on 21-10-2026\n Site, Seconds, DateTime, Water Level, Prediction, Residual, Latitude, Longitude\n\
            whyteislandnx,1792530000,2026-10-21T07:00,1.593,1.501,0.092,-27.4017,153.1574\n\
            whyteislandnx,1792530600,2026-10-21T07:10,1.551,1.471,0.080,-27.4017,153.1574\n\
            whyteislandnx,1792532400,2026-10-21T07:40,-99.000,1.370,-99.000,-27.4017,153.1574\n\
            abellpoint,1791900000,2026-10-14T00:00,2.089,2.089,0.000,-20.2608,148.7103\n";
        let s = parse_storm_tide(csv);
        let w = &s["whyteislandnx"];
        assert_eq!(w["at"], "2026-10-21T07:10:00+10:00", "the latest good reading, not the -99");
        assert_eq!(w["level"], 1.551);
        assert_eq!(w["residual"], 0.08);
        assert_eq!(w["residualMax24h"], 0.092);
        assert_eq!(w["lat"], -27.4017);
        assert_eq!(w["series"].as_array().unwrap().len(), 1, "half-hourly: 07:00 only");
        assert!(s.get("abellpoint").is_some());
    }

    #[test]
    fn tides_are_not_rising_rivers() {
        let tide: Vec<f64> = (0..30).map(|h| 1.0 + 0.8 * ((h as f64) * std::f64::consts::TAU / 12.42).sin()).collect();
        assert!(looks_tidal(&hourly_n(&tide)));
        let flood: Vec<f64> = (0..30).map(|h| 1.0 + (h as f64) * 0.1).collect();
        assert!(!looks_tidal(&hourly_n(&flood)));
        let mut e = json!({"latest": ["t", 1.0]});
        add_rise(&mut e, &hourly_n(&tide));
        assert_eq!(e["tidal"], true);
        let doc = json!({"level": {"T": {"latest": ["t", 1.0], "rise3h": 0.9, "tidal": true}}});
        assert_eq!(watch_list(&doc), json!([]), "a tidal gauge's rise isn't flagged");
    }

    #[test]
    fn surge_is_measured_against_the_sites_usual_residual() {
        // a site whose prediction always sits 1.7 m low, then a real 0.4 m surge
        let mut csv = String::from("Site, Seconds, DateTime, Water Level, Prediction, Residual, Latitude, Longitude\n");
        for i in 0..60 {
            let r = if i == 59 { 2.1 } else { 1.7 };
            csv.push_str(&format!("offset,{},2026-10-20T{:02}:{:02},{:.3},1.000,{:.3},-26.4,153.0\n", 1_792_440_000 + i * 600, i / 6, (i % 6) * 10, 1.0 + r, r));
        }
        let s = parse_storm_tide(&csv);
        assert_eq!(s["offset"]["residualNormal"], 1.7);
        assert_eq!(s["offset"]["surge"], 0.4);
        let w = watch_list(&json!({"sea": s}));
        assert_eq!(w[0]["station"], "offset");
    }

    fn hourly_n(levels: &[f64]) -> Vec<Value> {
        levels.iter().enumerate().map(|(i, v)| json!([format!("2026-10-{:02}T{:02}:00:00.000+10:00", 19 + i / 24, i % 24), v])).collect()
    }

    #[test]
    fn rain_cells_share_and_coarsen() {
        let coords: Vec<(String, f64, f64)> = vec![("a".into(), 153.02, -27.47), ("b".into(), 153.03, -27.48), ("c".into(), 150.5, -23.37)];
        let (cells, of) = rain_cells(&coords, 10);
        assert_eq!(cells.len(), 2, "a and b share a cell");
        assert_eq!(of["a"], of["b"]);
        let many: Vec<(String, f64, f64)> = (0..400).map(|i| (format!("g{}", i), 140.0 + (i % 20) as f64 * 0.3, -30.0 + (i / 20) as f64 * 0.3)).collect();
        let (cells, _) = rain_cells(&many, 100);
        assert!(cells.len() <= 100, "{}", cells.len());
    }

    #[test]
    fn a_failed_rain_batch_gets_a_second_try() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cells: Vec<(f64, f64)> = (0..150).map(|i| (-27.0 - i as f64 * 0.01, 153.0)).collect();
        let reply = |n: usize| json!((0..n).map(|_| json!({"hourly": {"time": [0], "precipitation": [1.0]}})).collect::<Vec<_>>());
        // the second batch fails once, then answers
        let calls = AtomicUsize::new(0);
        let http = |_: &str, ps: &[(String, String)]| -> Result<Value, String> {
            let n = ps.iter().find(|x| x.0 == "latitude").map(|x| x.1.split(',').count()).unwrap_or(0);
            let c = calls.fetch_add(1, Ordering::SeqCst);
            if n == 50 && c == 1 { Err("timeout: connect".into()) } else { Ok(reply(n)) }
        };
        let mut errors = Vec::new();
        let got = rain_forecast(&http, &cells, 0, &|| {}, &|| true, &mut errors);
        assert!(got.iter().all(Option::is_some), "all 150 filled after the retry");
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        // failing twice: reported once, the rest still filled
        let always = |_: &str, ps: &[(String, String)]| -> Result<Value, String> {
            let n = ps.iter().find(|x| x.0 == "latitude").map(|x| x.1.split(',').count()).unwrap_or(0);
            if n == 50 { Err("timeout: connect".into()) } else { Ok(reply(n)) }
        };
        let mut errors = Vec::new();
        let got = rain_forecast(&always, &cells, 0, &|| {}, &|| true, &mut errors);
        assert_eq!(got.iter().filter(|x| x.is_some()).count(), 100);
        assert_eq!(errors.len(), 1, "{errors:?}");
    }

    #[test]
    fn rain_sums_from_now() {
        let now = 1_800_000_000i64;
        let hours: Vec<i64> = (-2..80).map(|h| now - now % 3600 + h * 3600).collect();
        let http = |_: &str, ps: &[(String, String)]| -> R<Value> {
            let n = ps.iter().find(|x| x.0 == "latitude").unwrap().1.split(',').count();
            let one = json!({"hourly": {"time": hours, "precipitation": vec![1.0; 82]}});
            Ok(if n == 1 { one } else { Value::Array(vec![one; n]) })
        };
        let mut errors = Vec::new();
        let r = rain_forecast(&http, &[(-27.5, 153.0), (-23.4, 150.5)], now, &|| {}, &|| true, &mut errors);
        let (a, b) = r[0].unwrap();
        assert!((24.0..=26.0).contains(&a), "{}", a);
        assert!((72.0..=74.0).contains(&b), "{}", b);
        assert!(r[1].is_some());
    }
}

/* ---------------------------------------------------- flood warnings */

/// The Bureau's anonymous FTP server: its sanctioned channel for automated
/// access (its website turns automated requests away). Each current
/// warning is there as CAP (Common Alerting Protocol) XML, among others.
pub const BOM_FTP_HOST: &str = "ftp.bom.gov.au";
pub const BOM_FTP_DIR: &str = "/anon/gen/fwo/";

pub mod ftp {
    //! Anonymous FTP, passive mode: a directory's names and a file's bytes.
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    pub struct Session {
        ctl: TcpStream,
        rd: BufReader<TcpStream>,
        host: String,
        timeout: Duration,
    }

    fn connect(host: &str, port: u16, to: Duration) -> Result<TcpStream, String> {
        let addr = (host, port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
        let s = TcpStream::connect_timeout(&addr, to).map_err(|e| format!("ftp connect: {}", e))?;
        s.set_read_timeout(Some(to)).map_err(|e| e.to_string())?;
        s.set_write_timeout(Some(to)).map_err(|e| e.to_string())?;
        Ok(s)
    }

    impl Session {
        pub fn open(host: &str, timeout_s: u64) -> Result<Session, String> {
            let timeout = Duration::from_secs(timeout_s);
            let ctl = connect(host, 21, timeout)?;
            let rd = BufReader::new(ctl.try_clone().map_err(|e| e.to_string())?);
            let mut s = Session { ctl, rd, host: host.to_string(), timeout };
            let (c, m) = s.reply()?;
            if c != 220 {
                return Err(format!("ftp: {}", m));
            }
            let (c, m) = s.cmd("USER anonymous")?;
            if c == 331 {
                let (c2, m2) = s.cmd("PASS anonymous@")?;
                if c2 != 230 {
                    return Err(format!("ftp: {}", m2));
                }
            } else if c != 230 {
                return Err(format!("ftp: {}", m));
            }
            s.cmd("TYPE I")?;
            Ok(s)
        }

        fn reply(&mut self) -> Result<(u32, String), String> {
            let mut line = String::new();
            self.rd.read_line(&mut line).map_err(|e| e.to_string())?;
            let code: u32 = line.get(..3).and_then(|c| c.parse().ok()).ok_or_else(|| format!("ftp: odd reply {:?}", line))?;
            let mut all = line.clone();
            if line.as_bytes().get(3) == Some(&b'-') {
                loop {
                    let mut l = String::new();
                    if self.rd.read_line(&mut l).map_err(|e| e.to_string())? == 0 {
                        break;
                    }
                    all.push_str(&l);
                    if l.starts_with(&format!("{} ", code)) {
                        break;
                    }
                }
            }
            Ok((code, all.trim().to_string()))
        }

        fn cmd(&mut self, c: &str) -> Result<(u32, String), String> {
            self.ctl.write_all(format!("{}\r\n", c).as_bytes()).map_err(|e| e.to_string())?;
            self.reply()
        }

        fn transfer(&mut self, c: &str) -> Result<Vec<u8>, String> {
            let (code, m) = self.cmd("PASV")?;
            if code != 227 {
                return Err(format!("ftp: {}", m));
            }
            let inner = m.split('(').nth(1).and_then(|x| x.split(')').next()).ok_or("ftp: odd PASV reply")?;
            let n: Vec<u16> = inner.split(',').filter_map(|x| x.trim().parse().ok()).collect();
            if n.len() != 6 {
                return Err(format!("ftp: odd PASV reply {}", m));
            }
            let host = self.host.clone();
            let mut data = connect(&host, n[4] * 256 + n[5], self.timeout)?;
            let (code, m) = self.cmd(c)?;
            if code != 150 && code != 125 {
                return Err(format!("ftp: {}", m));
            }
            let mut body = Vec::new();
            data.read_to_end(&mut body).map_err(|e| e.to_string())?;
            drop(data);
            let (code, m) = self.reply()?;
            if code >= 400 {
                return Err(format!("ftp: {}", m));
            }
            Ok(body)
        }

        /// The names in a directory (NLST).
        pub fn list(&mut self, dir: &str) -> Result<Vec<String>, String> {
            let b = self.transfer(&format!("NLST {}", dir))?;
            Ok(String::from_utf8_lossy(&b).lines().map(|l| l.trim().rsplit('/').next().unwrap_or("").to_string()).filter(|l| !l.is_empty()).collect())
        }

        pub fn get(&mut self, path: &str) -> Result<Vec<u8>, String> {
            self.transfer(&format!("RETR {}", path))
        }
    }

    /// A directory listing and file getter (an FTP session, or a stand-in
    /// for tests). `list_meta` returns `(name, version)` where `version`
    /// is size + modification time when the server gives them (LIST), or
    /// empty when only names are known (NLST).
    pub trait Dir {
        fn list_meta(&mut self, dir: &str) -> Result<Vec<(String, String)>, String>;
        fn get(&mut self, path: &str) -> Result<Vec<u8>, String>;
    }

    /// Parse unix-style `LIST` lines (`-rw-r--r-- 1 u g 12345 Oct 21 09:00 IDQ20855.cap.xml`)
    /// into `(filename, "size mtime")`. Returns empty if no file lines match.
    pub fn parse_list_lines(raw: &str) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for line in raw.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 9 || f[0].starts_with('d') || f[0].starts_with("total") {
                continue;
            }
            let Some(size) = f[4].parse::<u64>().ok() else { continue };
            let name = f[8..].join(" ").rsplit('/').next().unwrap_or("").trim().to_string();
            if !name.is_empty() {
                out.push((name, format!("{} {} {} {}", size, f[5], f[6], f[7])));
            }
        }
        out
    }

    impl Dir for Session {
        fn list_meta(&mut self, dir: &str) -> Result<Vec<(String, String)>, String> {
            if let Ok(b) = self.transfer(&format!("LIST {}", dir)) {
                let parsed = parse_list_lines(&String::from_utf8_lossy(&b));
                if !parsed.is_empty() {
                    return Ok(parsed);
                }
            }
            Ok(self.list(dir)?.into_iter().map(|n| (n, String::new())).collect())
        }

        fn get(&mut self, path: &str) -> Result<Vec<u8>, String> {
            Session::get(self, path)
        }
    }

    impl Drop for Session {
        fn drop(&mut self) {
            let _ = self.ctl.write_all(b"QUIT\r\n");
        }
    }
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&")
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{}>", name);
    let a = xml.find(&open)? + open.len();
    let b = xml[a..].find(&format!("</{}>", name))? + a;
    Some(&xml[a..b])
}

/// The state a Bureau product ID belongs to (IDQ20860 is Queensland's).
pub fn product_state(id: &str) -> &'static str {
    match id.as_bytes().get(2) {
        Some(b'N') => "NSW",
        Some(b'V') => "VIC",
        Some(b'Q') => "QLD",
        Some(b'S') => "SA",
        Some(b'T') => "TAS",
        Some(b'W') => "WA",
        Some(b'D') => "NT",
        _ => "",
    }
}

/// A flood warning from a CAP file, or None if it isn't one (or has
/// expired): {id, state, title, severity, event, description, published,
/// expires, area, link}.
pub fn parse_cap_flood(xml: &str, now_s: i64) -> Option<Value> {
    let event = tag(xml, "event").map(xml_unescape)?;
    if !event.to_lowercase().contains("flood") {
        return None;
    }
    let expires = tag(xml, "expires").map(|s| s.trim().to_string());
    if expires.as_deref().and_then(ts_epoch).is_some_and(|t| t < now_s) {
        return None;
    }
    let ident = tag(xml, "identifier").unwrap_or("");
    let id = ident.split('-').find(|p| p.starts_with("ID") && p.len() >= 8).unwrap_or("").to_string();
    let get = |n: &str| tag(xml, n).map(|s| xml_unescape(s.trim())).unwrap_or_default();
    Some(json!({
        "id": id, "state": product_state(&id), "title": get("headline"), "severity": get("severity"), "event": event,
        "description": get("description"), "published": get("sent"), "expires": expires,
        "area": get("areaDesc"),
        "polygons": cap_polygons(xml),
        "geocodes": cap_geocodes(xml),
        "link": if id.is_empty() { "https://www.bom.gov.au/australia/warnings/".to_string() } else { format!("https://www.bom.gov.au/products/{}.shtml", id) },
    }))
}

/// The Bureau's flood warning catchments (National Flood Gauge Network).
pub const WARNING_AREAS: &str = "https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/flood/National_Flood_Gauge_Network/FeatureServer/1/query";

/// A Bureau area code as in a warning's geocodes, e.g. QLD_RC125.
pub fn is_area_code(c: &str) -> bool {
    let b = c.as_bytes();
    let Some(u) = c.find('_') else { return false };
    (2..=3).contains(&u) && b[..u].iter().all(u8::is_ascii_uppercase) && c.len() == u + 6 && b[u + 1..u + 3].iter().all(u8::is_ascii_uppercase) && b[u + 3..].iter().all(u8::is_ascii_digit)
}

/// A Bureau product ID, e.g. IDQ20855.
pub fn is_product_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 8 && id.starts_with("ID") && b[2].is_ascii_uppercase() && b[3..].iter().all(u8::is_ascii_digit)
}

/// GeoJSON polygons as [lat, lon] rings, and the features' dist_name.
pub fn geojson_rings(gj: &Value) -> (Vec<Vec<[f64; 2]>>, Vec<String>) {
    let mut rings = Vec::new();
    let mut names = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        if let Some(n) = f["properties"]["dist_name"].as_str() {
            names.push(n.to_string());
        }
        let g = &f["geometry"];
        let polys: Vec<&Value> = match g["type"].as_str() {
            Some("Polygon") => vec![&g["coordinates"]],
            Some("MultiPolygon") => g["coordinates"].as_array().map(|a| a.iter().collect()).unwrap_or_default(),
            _ => vec![],
        };
        for poly in polys {
            for ring in poly.as_array().into_iter().flatten() {
                let r: Vec<[f64; 2]> = ring.as_array().into_iter().flatten().filter_map(|p| Some([p[1].as_f64()?, p[0].as_f64()?])).collect();
                if r.len() >= 3 {
                    rings.push(r);
                }
            }
        }
    }
    (rings, names)
}

/// Every tag's text, in order (`tag` gives only the first).
fn tags<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let (open, close) = (format!("<{}>", name), format!("</{}>", name));
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(a) = rest.find(&open) {
        let from = a + open.len();
        let Some(b) = rest[from..].find(&close) else { break };
        out.push(&rest[from..from + b]);
        rest = &rest[from + b + close.len()..];
    }
    out
}

/// A CAP warning's areas as rings of [lat, lon] ("lat,lon lat,lon ..."),
/// for drawing on the map. Bad pairs are skipped; rings of under 3 dropped.
pub fn cap_polygons(xml: &str) -> Vec<Vec<[f64; 2]>> {
    tags(xml, "polygon")
        .into_iter()
        .map(|t| {
            t.split_whitespace()
                .filter_map(|p| {
                    let (a, b) = p.split_once(',')?;
                    let (lat, lon) = (a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?);
                    ((-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon)).then_some([(lat * 1e4).round() / 1e4, (lon * 1e4).round() / 1e4])
                })
                .collect::<Vec<_>>()
        })
        .filter(|r| r.len() >= 3)
        .collect()
}

/// A CAP warning's area codes (<geocode><value>), e.g. the Bureau's
/// forecast district or river basin codes.
pub fn cap_geocodes(xml: &str) -> Vec<String> {
    tags(xml, "geocode").into_iter().filter_map(|g| tag(g, "value")).map(|v| xml_unescape(v.trim())).filter(|v| !v.is_empty()).collect()
}

/// Every current flood warning on the Bureau's FTP server, as the map's
/// warnings.json: {ok, fetched, source, warnings: [...]}, most severe first.
pub fn flood_warnings(now_s: i64, iso_now: &str, errors: &mut Vec<String>) -> Value {
    use ftp::Dir;
    let fail = |e: String, errors: &mut Vec<String>| {
        errors.push(format!("flood warnings: {}", e));
        json!({"ok": false, "fetched": iso_now, "source": "ftp", "warnings": [], "error": e})
    };
    let mut s = match ftp::Session::open(BOM_FTP_HOST, 30) {
        Ok(s) => s,
        Err(e) => return fail(e, errors),
    };
    let files = match s.list_meta(BOM_FTP_DIR) {
        Ok(f) => f,
        Err(e) => return fail(e, errors),
    };
    let mut cache = HashMap::new();
    flood_warnings_from(&mut s, &files, &mut cache, now_s, iso_now, errors).0
}

#[cfg(test)]
mod warning_tests {
    use super::*;

    #[test]
    fn warning_catchments_from_the_map_service() {
        assert!(is_area_code("QLD_RC125") && is_area_code("NSW_FL001") && !is_area_code("QLD_RC12") && !is_area_code("x'); DROP"));
        assert!(is_product_id("IDQ20855") && !is_product_id("IDQ2085") && !is_product_id("IDQ2085'"));
        let gj = json!({"features": [{"properties": {"dist_name": "Bulloo River to Quilpie"}, "geometry": {"type": "Polygon", "coordinates": [[[144.0, -26.0], [145.0, -26.0], [145.0, -27.0], [144.0, -26.0]]]}},
            {"properties": {"dist_name": "B"}, "geometry": {"type": "MultiPolygon", "coordinates": [[[[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]]]]}}]});
        let (r, n) = geojson_rings(&gj);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0][0], [-26.0, 144.0], "lat, lon");
        assert_eq!(n, vec!["Bulloo River to Quilpie", "B"]);
    }

    #[test]
    fn cap_areas_come_out_as_rings_and_codes() {
        let xml = "<info><area><areaDesc>x</areaDesc><polygon>-24.1,145.2 -24.5,145.9 -25.0,145.1 -24.1,145.2</polygon><polygon>bad</polygon><geocode><valueName>AMOC-AreaCode</valueName><value>QLD_RV038</value></geocode><geocode><valueName>b</valueName><value>QLD_PW013</value></geocode></area></info>";
        assert_eq!(cap_polygons(xml), vec![vec![[-24.1, 145.2], [-24.5, 145.9], [-25.0, 145.1], [-24.1, 145.2]]]);
        assert_eq!(cap_geocodes(xml), vec!["QLD_RV038".to_string(), "QLD_PW013".to_string()]);
    }

    const CAP: &str = r#"<?xml version="1.0" encoding="UTF-8"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><identifier>AusBoM-IDQ20860-2026-10-20T01:33:24+00:00</identifier><sent>2026-10-20T01:33:24+00:00</sent><info><event>Riverine Flood</event><severity>Minor</severity><expires>2026-10-23T04:33:24+00:00</expires><headline>Minor Flood Warning for Barcoo River to Isisford and Barcoo River at Blackall</headline><description>The Barcoo River at Blackall may peak above the minor flood level (2.00 m) from Tuesday into Wednesday &amp; more.</description><area><areaDesc>Queensland: Barcoo River to Isisford and Barcoo River at Blackall</areaDesc></area></info></alert>"#;

    #[test]
    fn cap_flood_warning() {
        let now = ts_epoch("2026-10-21T00:00:00Z").unwrap();
        let w = parse_cap_flood(CAP, now).unwrap();
        assert_eq!(w["id"], "IDQ20860");
        assert_eq!(w["polygons"], json!([]), "no area outline in this one");
        assert_eq!(w["state"], "QLD");
        assert_eq!(w["severity"], "Minor");
        assert!(w["title"].as_str().unwrap().starts_with("Minor Flood Warning for Barcoo River"));
        assert!(w["description"].as_str().unwrap().ends_with("& more."));
        assert_eq!(w["link"], "https://www.bom.gov.au/products/IDQ20860.shtml");
        let later = ts_epoch("2026-10-24T00:00:00Z").unwrap();
        assert!(parse_cap_flood(CAP, later).is_none(), "expired");
        assert!(parse_cap_flood(&CAP.replace("Riverine Flood", "Severe Thunderstorm"), now).is_none(), "not a flood");
    }

    struct FakeFtp {
        listing: Vec<(String, String)>,
        files: HashMap<String, Vec<u8>>,
        gets: Vec<String>,
    }

    impl ftp::Dir for FakeFtp {
        fn list_meta(&mut self, _: &str) -> Result<Vec<(String, String)>, String> {
            Ok(self.listing.clone())
        }
        fn get(&mut self, path: &str) -> Result<Vec<u8>, String> {
            let name = path.rsplit('/').next().unwrap_or(path).to_string();
            self.gets.push(name.clone());
            self.files.get(&name).cloned().ok_or_else(|| format!("missing {}", name))
        }
    }

    #[test]
    fn ftp_lists_once_and_downloads_only_changed_or_new_files() {
        let raw = "total 16\ndrwxr-xr-x 2 0 0 4096 Oct 21 09:00 .\n-rw-r--r-- 1 0 0 812 Oct 21 09:00 IDQ20860.cap.xml\n-rw-r--r-- 1 0 0 2048 Oct 21 08:30 IDQ65301.html\n";
        assert_eq!(
            ftp::parse_list_lines(raw),
            vec![
                ("IDQ20860.cap.xml".into(), "812 Oct 21 09:00".into()),
                ("IDQ65301.html".into(), "2048 Oct 21 08:30".into()),
            ]
        );
        let now = ts_epoch("2026-10-21T00:00:00Z").unwrap();
        let page = r#"<area onmouseover="javascript:PopupRiver(&quot;Balonne River at St George&quot;,'043104','-28.0667','148.5667','0.86','Below Flood Level','steady','21-10-2026 08:00:00','6.00','8.00','10.00','Click')"/>"#;
        let cap2 = CAP.replace("IDQ20860", "IDN20861").replace("Barcoo", "Lachlan");
        let mut fake = FakeFtp {
            listing: vec![
                ("IDQ20860.cap.xml".into(), "812 Oct 21 09:00".into()),
                ("IDN20861.cap.xml".into(), "815 Oct 21 09:05".into()),
                ("IDQ65301.html".into(), "2048 Oct 21 08:30".into()),
            ],
            files: [
                ("IDQ20860.cap.xml".into(), CAP.as_bytes().to_vec()),
                ("IDN20861.cap.xml".into(), cap2.as_bytes().to_vec()),
                ("IDQ65301.html".into(), page.as_bytes().to_vec()),
            ]
            .into(),
            gets: Vec::new(),
        };
        let mut cache = HashMap::new();
        let mut errs = Vec::new();
        let (w1, fc1, dl1) = flood_ftp_both(&mut fake, &mut cache, now, "2026-10-21T00:00:00Z", true, &mut errs);
        assert!(errs.is_empty(), "{errs:?}");
        assert_eq!(dl1, 3, "first refresh downloads all three");
        assert_eq!(w1["warnings"].as_array().unwrap().len(), 2);
        assert!(fc1.unwrap()["43104"].is_object());

        // Second refresh: IDQ20860 disappeared (expired), IDN20861 unchanged, IDQ65301 changed
        fake.gets.clear();
        fake.listing = vec![
            ("IDN20861.cap.xml".into(), "815 Oct 21 09:05".into()),
            ("IDQ65301.html".into(), "2052 Oct 21 09:15".into()),
        ];
        let (w2, fc2, dl2) = flood_ftp_both(&mut fake, &mut cache, now, "2026-10-21T00:15:00Z", true, &mut errs);
        assert_eq!(dl2, 1, "only the changed file is downloaded");
        assert_eq!(fake.gets, vec!["IDQ65301.html".to_string()]);
        assert_eq!(w2["warnings"].as_array().unwrap().len(), 1, "disappeared warning dropped");
        assert_eq!(w2["warnings"][0]["id"], "IDN20861");
        assert!(!cache.contains_key("IDQ20860.cap.xml"), "removed from cache too");
        assert!(fc2.unwrap()["43104"].is_object());
    }
}

/* ------------------------------------------------- flood class levels */

/// Split a popup call's arguments (`"name",'station','lat',...`) on commas
/// outside quotes.
fn split_popup_args(raw: &str) -> Vec<String> {
    let args_src = xml_unescape(raw);
    let (mut args, mut cur, mut q) = (Vec::new(), String::new(), None::<char>);
    for ch in args_src.chars() {
        match (q, ch) {
            (None, '\'' | '"') => q = Some(ch),
            (Some(c), _) if ch == c => q = None,
            (None, ',') => args.push(std::mem::take(&mut cur).trim().to_string()),
            _ => cur.push(ch),
        }
    }
    args.push(cur.trim().to_string());
    args
}

/// One gauge from the Bureau's river height map pages (IDx653xx.html on
/// the FTP server): each gauge's marker carries
/// PopupRiver("name", 'station', 'lat', 'lon', 'level', 'class',
/// 'tendency', 'dd-mm-yyyy hh:mm:ss', 'minor', 'moderate', 'major', ...).
pub fn parse_river_popups(html: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("PopupRiver(") {
        rest = &rest[i + "PopupRiver(".len()..];
        let end = rest.find(')').unwrap_or(rest.len());
        let args = split_popup_args(&rest[..end]);
        if args.len() < 11 {
            continue;
        }
        let num = |s: &str| s.trim().parse::<f64>().ok().filter(|v| v.is_finite());
        let station = args[1].trim().trim_start_matches('0').to_string();
        if station.is_empty() || !station.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // "21-10-2026 09:00:01" (local time at the gauge; no zone given)
        let at = {
            let t = args[7].trim();
            if t.len() >= 16 { format!("{}-{}-{}T{}", &t[6..10], &t[3..5], &t[0..2], &t[11..]) } else { String::new() }
        };
        out.push(json!({
            "station": station, "name": args[0], "lat": num(&args[2]), "lon": num(&args[3]),
            "level": num(&args[4]), "class": args[5], "tendency": args[6], "at": at,
            "minor": num(&args[8]), "moderate": num(&args[9]), "major": num(&args[10]),
        }));
    }
    out
}

/// One rain gauge from the Bureau's rainfall map pages (IDx653xx.html on
/// the FTP server): `PopupRain("name", 'station', 'lat', 'lon', 'mm',
/// 'hours', 'hour')`.
pub fn parse_rain_popups(html: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("PopupRain(") {
        rest = &rest[i + "PopupRain(".len()..];
        let end = rest.find(')').unwrap_or(rest.len());
        let args = split_popup_args(&rest[..end]);
        if args.len() < 6 {
            continue;
        }
        let num = |s: &str| s.trim().parse::<f64>().ok().filter(|v| v.is_finite());
        let station = args[1].trim().trim_start_matches('0').to_string();
        if station.is_empty() || !station.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let (Some(lat), Some(lon), Some(mm), Some(hours)) = (num(&args[2]), num(&args[3]), num(&args[4]).filter(|v| *v >= 0.0), args[5].trim().parse::<u32>().ok()) else {
            continue;
        };
        out.push(json!({"station": station, "name": args[0], "lat": lat, "lon": lon, "mm": round_to(mm, 1), "hours": hours}));
    }
    out
}

/// Every flood gauge's class levels and current class from the river height
/// map pages: {Bureau station number: {name, minor, moderate, major, class,
/// tendency, level, at, lat, lon}} (150-second limit).
pub fn flood_classes(errors: &mut Vec<String>) -> Value {
    use ftp::Dir;
    let mut s = match ftp::Session::open(BOM_FTP_HOST, 30) {
        Ok(s) => s,
        Err(e) => {
            errors.push(format!("flood classes: {}", e));
            return Value::Object(Map::new());
        }
    };
    let files = match s.list_meta(BOM_FTP_DIR) {
        Ok(f) => f,
        Err(e) => {
            errors.push(format!("flood classes: {}", e));
            return Value::Object(Map::new());
        }
    };
    let mut cache = HashMap::new();
    flood_classes_from(&mut s, &files, &mut cache, errors).0
}

/// warnings.json from an open FTP directory (`files` from `list_meta`), reusing
/// `cache` (`{filename: (version, parsed_warning_or_null)}`) so unchanged CAP
/// files aren't downloaded again; entries for files that disappeared are dropped.
/// Returns `(warnings_doc, downloaded_count)`.
pub fn flood_warnings_from(
    dir: &mut dyn ftp::Dir,
    files: &[(String, String)],
    cache: &mut HashMap<String, (String, Value)>,
    now_s: i64,
    iso_now: &str,
    errors: &mut Vec<String>,
) -> (Value, usize) {
    let caps: Vec<&(String, String)> = files.iter().filter(|(n, _)| n.ends_with(".cap.xml") && n.starts_with("ID")).collect();
    let live: HashSet<&str> = caps.iter().map(|(n, _)| n.as_str()).collect();
    cache.retain(|k, _| !k.ends_with(".cap.xml") || live.contains(k.as_str()));
    let mut out = Vec::new();
    let mut downloaded = 0usize;
    let t0 = std::time::Instant::now();
    for (n, ver) in &caps {
        let hit = !ver.is_empty() && cache.get(n).is_some_and(|(v, _)| v == ver);
        let parsed = if hit {
            cache[n].1.clone()
        } else {
            if t0.elapsed().as_secs() > 90 {
                errors.push("flood warnings: out of time; the rest wait for the next refresh".into());
                break;
            }
            match dir.get(&format!("{}{}", BOM_FTP_DIR, n)) {
                Ok(b) => {
                    downloaded += 1;
                    let w = parse_cap_flood(&String::from_utf8_lossy(&b), now_s).unwrap_or(Value::Null);
                    cache.insert(n.clone(), (ver.clone(), w.clone()));
                    w
                }
                Err(e) => {
                    errors.push(format!("flood warnings {}: {}", n, e));
                    cache.get(n).map(|(_, w)| w.clone()).unwrap_or(Value::Null)
                }
            }
        };
        if parsed.is_object() && parsed["expires"].as_str().and_then(ts_epoch).is_none_or(|t| t >= now_s) {
            out.push(parsed);
        }
    }
    let rank = |w: &Value| match w["severity"].as_str().unwrap_or("") {
        "Extreme" | "Major" => 0,
        "Severe" | "Moderate" => 1,
        "Minor" => 2,
        _ => 3,
    };
    out.sort_by_key(|w| (rank(w), w["state"].as_str().unwrap_or("").to_string()));
    let doc = json!({
        "ok": true, "fetched": iso_now, "source": "ftp",
        "capFiles": files.iter().filter(|(n, _)| n.ends_with(".cap.xml")).count(),
        "downloaded": downloaded,
        "attribution": "© Commonwealth of Australia (Bureau of Meteorology)",
        "warnings": out,
    });
    (doc, downloaded)
}

/// Flood class levels, current classes, and observed rainfall from an open FTP
/// directory (`files` from `list_meta`), reusing `cache` (`{filename: (version,
/// {river: [...], rain: [...]})}`) for unchanged `IDx653xx.html` pages and
/// dropping pages that disappeared.
/// Returns `(classes_doc, rain_obs_doc, downloaded_count)`.
pub fn flood_classes_and_rain_from(
    dir: &mut dyn ftp::Dir,
    files: &[(String, String)],
    cache: &mut HashMap<String, (String, Value)>,
    errors: &mut Vec<String>,
) -> (Value, Value, usize) {
    let pages: Vec<&(String, String)> = files.iter().filter(|(n, _)| n.len() == 13 && n.starts_with("ID") && n.ends_with(".html") && &n[3..6] == "653").collect();
    let live: HashSet<&str> = pages.iter().map(|(n, _)| n.as_str()).collect();
    cache.retain(|k, _| !k.ends_with(".html") || live.contains(k.as_str()));
    let mut out = Map::new();
    let mut rain_out = Map::new();
    let mut downloaded = 0usize;
    let t0 = std::time::Instant::now();
    for (n, ver) in &pages {
        let hit = !ver.is_empty() && cache.get(n).is_some_and(|(v, val)| v == ver && (val.is_object() || val.is_array()));
        let (gauges, rain) = if hit {
            let val = &cache[n].1;
            if let Some(arr) = val.as_array() {
                (arr.clone(), Vec::new())
            } else {
                (
                    val["river"].as_array().cloned().unwrap_or_default(),
                    val["rain"].as_array().cloned().unwrap_or_default(),
                )
            }
        } else {
            if t0.elapsed().as_secs() > 150 {
                errors.push("flood classes: out of time; the rest wait for the next refresh".into());
                break;
            }
            match dir.get(&format!("{}{}", BOM_FTP_DIR, n)) {
                Ok(b) => {
                    downloaded += 1;
                    let text = String::from_utf8_lossy(&b);
                    let gs = parse_river_popups(&text);
                    let rn = parse_rain_popups(&text);
                    cache.insert(n.clone(), (ver.clone(), json!({"river": gs, "rain": rn})));
                    (gs, rn)
                }
                Err(e) => {
                    errors.push(format!("flood classes {}: {}", n, e));
                    let val = cache.get(n).map(|(_, v)| v.clone()).unwrap_or(Value::Null);
                    (
                        val["river"].as_array().or_else(|| val.as_array()).cloned().unwrap_or_default(),
                        val["rain"].as_array().cloned().unwrap_or_default(),
                    )
                }
            }
        };
        for g in gauges {
            let has_levels = ["minor", "moderate", "major"].iter().any(|k| g[*k].is_number());
            let st = g["station"].as_str().unwrap_or("").to_string();
            // the same gauge can be on several pages: keep one with levels
            if has_levels || !out.contains_key(&st) {
                out.insert(st, g);
            }
        }
        for rg in rain {
            let st = rg["station"].as_str().unwrap_or("").to_string();
            let (Some(mm), Some(hrs)) = (rg["mm"].as_f64(), rg["hours"].as_u64()) else { continue };
            let entry = rain_out.entry(st).or_insert_with(|| json!({"name": rg["name"], "lat": rg["lat"], "lon": rg["lon"]}));
            match hrs {
                24 => entry["mm24h"] = json!(mm),
                6 | 7 => entry["mm6h"] = json!(mm),
                1 => entry["mm1h"] = json!(mm),
                _ => {}
            }
        }
    }
    // Keep only gauges with at least a 24 h or 6 h reading
    rain_out.retain(|_, v| v.get("mm24h").is_some() || v.get("mm6h").is_some());
    (Value::Object(out), Value::Object(rain_out), downloaded)
}

/// Flood class levels and current classes from an open FTP directory (`files`
/// from `list_meta`), reusing `cache` (`{filename: (version, ...)}`)
/// for unchanged `IDx653xx.html` pages and dropping pages that disappeared.
/// Returns `(classes_doc, downloaded_count)`.
pub fn flood_classes_from(
    dir: &mut dyn ftp::Dir,
    files: &[(String, String)],
    cache: &mut HashMap<String, (String, Value)>,
    errors: &mut Vec<String>,
) -> (Value, usize) {
    let (fc, _, dl) = flood_classes_and_rain_from(dir, files, cache, errors);
    (fc, dl)
}

/// Flood warnings, flood class/river height pages, and observed rainfall over
/// a single FTP session, downloading only files whose LIST size/mtime changed
/// since `cache`.
pub fn flood_ftp_all(
    dir: &mut dyn ftp::Dir,
    cache: &mut HashMap<String, (String, Value)>,
    now_s: i64,
    iso_now: &str,
    want_classes: bool,
    errors: &mut Vec<String>,
) -> (Value, Option<Value>, Option<Value>, usize) {
    let files = match dir.list_meta(BOM_FTP_DIR) {
        Ok(f) => f,
        Err(e) => {
            errors.push(format!("flood warnings: {}", e));
            if want_classes {
                errors.push(format!("flood classes: {}", e));
            }
            let w = json!({"ok": false, "fetched": iso_now, "source": "ftp", "warnings": [], "error": e});
            return (w, want_classes.then(|| Value::Object(Map::new())), want_classes.then(|| Value::Object(Map::new())), 0);
        }
    };
    let (w, dw) = flood_warnings_from(dir, &files, cache, now_s, iso_now, errors);
    let (fc, ro, dc) = if want_classes {
        let (fc, ro, d) = flood_classes_and_rain_from(dir, &files, cache, errors);
        (Some(fc), Some(ro), d)
    } else {
        (None, None, 0)
    };
    (w, fc, ro, dw + dc)
}

/// Both flood warnings and flood class/river height pages over a single FTP
/// session, downloading only files whose LIST size/mtime changed since `cache`.
pub fn flood_ftp_both(
    dir: &mut dyn ftp::Dir,
    cache: &mut HashMap<String, (String, Value)>,
    now_s: i64,
    iso_now: &str,
    want_classes: bool,
    errors: &mut Vec<String>,
) -> (Value, Option<Value>, usize) {
    let (w, fc, _, dl) = flood_ftp_all(dir, cache, now_s, iso_now, want_classes, errors);
    (w, fc, dl)
}

/// Is a Bureau flood class one of minor, moderate or major flooding?
pub fn class_rank(class: &str) -> u8 {
    let c = class.to_lowercase();
    if c.contains("major") { 3 } else if c.contains("moderate") { 2 } else if c.contains("minor") { 1 } else { 0 }
}

#[cfg(test)]
mod class_tests {
    use super::*;

    #[test]
    fn river_popups() {
        let html = r#"<area onmouseover="javascript:PopupRiver(&quot;Balonne River at St George&quot;,'043104','-28.0667','148.5667','0.86','Below Flood Level','steady','21-10-2026 08:00:00','6.00','8.00','10.00','Click mouse to display plot')"/>
<area onmouseover="javascript:PopupRiver(&quot;Moonie River at Gundablouie&quot;,'548006','-29.1667','148.6333','-0.18','No Classification','steady','21-10-2026 09:00:01','','','','Click')"/>
<area onmouseover="javascript:PopupRiver(&quot;Barcoo River at Blackall, Qld&quot;,'036034','-24.42','145.47','2.10','Minor','rising','21-10-2026 09:00:00','2.00','3.50','5.00','x')"/>"#;
        let g = parse_river_popups(html);
        assert_eq!(g.len(), 3);
        assert_eq!(g[0]["station"], "43104", "leading zeros dropped, as the map's Bureau numbers are");
        assert_eq!(g[0]["minor"], 6.0);
        assert_eq!(g[0]["major"], 10.0);
        assert_eq!(g[0]["at"], "2026-10-21T08:00:00");
        assert_eq!(g[1]["minor"], Value::Null);
        assert_eq!(g[2]["name"], "Barcoo River at Blackall, Qld", "commas inside the name survive");
        assert_eq!(class_rank(g[2]["class"].as_str().unwrap()), 1);
        assert_eq!(class_rank("Below Flood Level"), 0);
    }
}

/* ------------------------------- the Bureau's levels as the level now */

/// UTC offset (seconds) of an Australian state's local time on a date:
/// daylight saving from the first Sunday in October to the first Sunday in
/// April in NSW, the ACT, Victoria, Tasmania and South Australia.
pub fn state_offset_s(state: &str, y: i64, m: i64, d: i64) -> i64 {
    let st = state.trim().to_uppercase();
    let st = match st.as_str() {
        "QUEENSLAND" => "QLD",
        "NEW SOUTH WALES" => "NSW",
        "VICTORIA" => "VIC",
        "TASMANIA" => "TAS",
        "SOUTH AUSTRALIA" => "SA",
        "WESTERN AUSTRALIA" => "WA",
        "NORTHERN TERRITORY" => "NT",
        "AUSTRALIAN CAPITAL TERRITORY" => "ACT",
        x => x,
    };
    let base = match st {
        "WA" => 8 * 3600,
        "NT" | "SA" => 9 * 3600 + 1800,
        _ => 10 * 3600,
    };
    let dst_state = matches!(st, "NSW" | "ACT" | "VIC" | "TAS" | "SA");
    if !dst_state {
        return base;
    }
    // the first Sunday of a month (1 = Monday ... 7 = Sunday, by Zeller-ish day count)
    let weekday = |y: i64, m: i64, d: i64| -> i64 {
        let days = ts_epoch(&format!("{:04}-{:02}-{:02}T00:00:00Z", y, m, d)).unwrap_or(0) / 86400;
        (days + 3).rem_euclid(7) + 1 // 1970-01-01 was a Thursday (4)
    };
    let first_sunday = |y: i64, m: i64| (1..=7).find(|&d| weekday(y, m, d) == 7).unwrap_or(1);
    let in_dst = (m > 10 || (m == 10 && d >= first_sunday(y, 10))) || (m < 4 || (m == 4 && d < first_sunday(y, 4)));
    base + if in_dst { 3600 } else { 0 }
}

/// The Bureau's river height levels (flood_classes) as the level now where
/// they're newer than the readings': stations maps Bureau number -> station,
/// states station -> state (for the local time). Returns how many it set.
pub fn bureau_levels(level: &mut Value, classes: &Value, stations: &HashMap<String, String>, states: &HashMap<String, String>) -> usize {
    let (Some(lv), Some(fc)) = (level.as_object_mut(), classes.as_object()) else { return 0 };
    let mut n = 0;
    for (bom, g) in fc {
        let (Some(st), Some(v), Some(at)) = (stations.get(bom), g["level"].as_f64(), g["at"].as_str().filter(|a| a.len() >= 16)) else { continue };
        let (Ok(y), Ok(m), Ok(d)) = (at[0..4].parse::<i64>(), at[5..7].parse::<i64>(), at[8..10].parse::<i64>()) else { continue };
        let off = state_offset_s(states.get(st).map(String::as_str).unwrap_or("QLD"), y, m, d);
        let iso = format!("{}{}{:02}:{:02}", &at[..19.min(at.len())], if off < 0 { '-' } else { '+' }, off.abs() / 3600, off.abs() % 3600 / 60);
        let Some(t) = ts_epoch(&iso) else { continue };
        match lv.get_mut(st) {
            Some(e) => {
                let older = e["latest"][0].as_str().and_then(ts_epoch).is_none_or(|t0| t > t0);
                if older {
                    e["latest"] = json!([iso, v]);
                    e["latestKind"] = json!("bureau");
                    n += 1;
                }
            }
            None => {
                lv.insert(st.clone(), json!({"unit": "m", "series": [], "latest": [iso, v], "latestKind": "bureau"}));
                n += 1;
            }
        }
    }
    n
}

#[cfg(test)]
mod bureau_level_tests {
    use super::*;

    #[test]
    fn local_times() {
        assert_eq!(state_offset_s("QLD", 2026, 10, 21), 36000);
        assert_eq!(state_offset_s("NSW", 2026, 10, 21), 39600, "daylight saving from 4 October 2026");
        assert_eq!(state_offset_s("NSW", 2026, 10, 3), 36000, "not yet");
        assert_eq!(state_offset_s("SA", 2026, 1, 15), 37800);
        assert_eq!(state_offset_s("Western Australia", 2026, 1, 15), 28800);
        assert_eq!(state_offset_s("NT", 2026, 1, 15), 34200);
        assert_eq!(state_offset_s("VIC", 2026, 4, 6), 36000, "ended 5 April 2026");
    }

    #[test]
    fn newer_bureau_levels_win() {
        let mut level = json!({
            "A": {"latest": ["2026-10-20T00:00:00.000+10:00", 1.0], "latestKind": "daily"},
            "B": {"latest": ["2026-10-21T09:00:00+10:00", 2.0], "latestKind": "realtime"},
        });
        let classes = json!({
            "100": {"level": 1.5, "at": "2026-10-21T08:00:00"},
            "200": {"level": 2.1, "at": "2026-10-21T08:00:00"},
            "300": {"level": 0.4, "at": "2026-10-21T08:00:00"},
        });
        let stations: HashMap<String, String> = [("100", "A"), ("200", "B"), ("300", "C")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let states: HashMap<String, String> = [("A", "NSW"), ("B", "QLD"), ("C", "QLD")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        assert_eq!(bureau_levels(&mut level, &classes, &stations, &states), 2);
        assert_eq!(level["A"]["latest"], json!(["2026-10-21T08:00:00+11:00", 1.5]), "NSW daylight time");
        assert_eq!(level["A"]["latestKind"], "bureau");
        assert_eq!(level["B"]["latestKind"], "realtime", "the live Queensland hour is newer");
        assert_eq!(level["C"]["latest"][1], 0.4, "a gauge with no reading gets one");
    }
}

/* ------------------------------------------- official road closures */

/// Queensland Department of Transport and Main Roads QLDTraffic v2 events API
/// (the public key published in the QLDTraffic website API specification).
pub const QLD_TRAFFIC_URL: &str = "https://api.qldtraffic.qld.gov.au/v2/events";
pub const QLD_TRAFFIC_PUBLIC_KEY: &str = "3e83add325cbb69ac4d8e5bf433d770b";
pub const QLD_TRAFFIC_ATTRIBUTION: &str = "© The State of Queensland (Department of Transport and Main Roads)";
/// Transport for NSW Live Traffic hazards (requires `Authorization: apikey <key>`).
pub const NSW_TRAFFIC_URL: &str = "https://api.transport.nsw.gov.au/v1/live/hazards/flood-open.json";
pub const NSW_TRAFFIC_ATTRIBUTION: &str = "© Transport for NSW (CC BY)";

/// Western Australia, Main Roads WebEOC Road Closures (ArcGIS FeatureServer,
/// open, no key). IncidentType includes Bushfire.
pub const WA_ROADS_URL: &str = "https://services2.arcgis.com/cHGEnmsJ165IBJRM/arcgis/rest/services/WebEoc_RoadClosures/FeatureServer/4/query?where=1%3D1&outFields=*&f=json&resultRecordCount=2000&returnGeometry=true&outSR=4326";
pub const WA_ROADS_ATTRIBUTION: &str = "© Main Roads Western Australia (WebEOC road closures)";
/// South Australia, DIT Traffic SA open data (ArcGIS MapServer, open, no key).
pub const SA_ROADS_URL: &str = "https://maps.sa.gov.au/arcgis/rest/services/DPTIExtTransport/TrafficSAOpenData/MapServer/0/query?where=1%3D1&outFields=*&f=json&resultRecordCount=2000&returnGeometry=true&outSR=4326";
pub const SA_ROADS_ATTRIBUTION: &str = "© Government of South Australia (Department for Infrastructure and Transport)";
/// Northern Territory, Road Report NT obstructions (open JSON, no key).
pub const NT_ROADS_URL: &str = "https://roadreport.nt.gov.au/api/Obstruction/GetAll";
pub const NT_ROADS_ATTRIBUTION: &str = "© Northern Territory Government (Department of Infrastructure, Planning and Logistics)";
/// Tasmania, State Growth road works (GeoServer WFS, open, no key).
pub const TAS_ROADS_URL: &str = "https://data.stategrowth.tas.gov.au/geoserver/ssg/ows?service=WFS&version=1.0.0&request=GetFeature&typeName=ssg%3AGEO_ROAD_WORKS&maxFeatures=500&outputFormat=application/json&srsName=EPSG:4326";
pub const TAS_ROADS_ATTRIBUTION: &str = "© State of Tasmania (Department of State Growth)";
/// Australian Capital Territory, temporary road closures (ArcGIS FeatureServer, open, no key).
pub const ACT_ROADS_URL: &str = "https://services1.arcgis.com/E5n4f1VY84i0xSjy/arcgis/rest/services/Public_Temporary_Road_Closures/FeatureServer/0/query?where=1%3D1&outFields=*&f=json&resultRecordCount=2000&returnGeometry=true&outSR=4326";
pub const ACT_ROADS_ATTRIBUTION: &str = "© ACT Government (Transport Canberra and City Services)";
/// NSW Rural Fire Service major incidents (public GeoJSON, no key). Carries
/// ALERT LEVEL (Advice / Watch and Act / Emergency Warning) and a Planned
/// Burn category — the Australian Warning System pattern for fire.
pub const NSW_RFS_MAJOR_INCIDENTS_URL: &str = "https://www.rfs.nsw.gov.au/feeds/majorIncidents.json";
pub const NSW_RFS_ATTRIBUTION: &str = "© NSW Rural Fire Service";

/// Simplify a GeoJSON geometry into `(center_lat, center_lon, optional_line)`
/// where `line` has points at least ~100 m apart (0.001°) and at most 40 points.
fn road_geometry(geom: &Value) -> Option<(f64, f64, Vec<[f64; 2]>)> {
    // ArcGIS (Esri) geometries use "paths" (polyline) or "x"/"y" (point)
    // instead of GeoJSON's "type"/"coordinates"; normalise to GeoJSON first
    let geom = if geom.get("paths").is_some() {
        json!({"type": "MultiLineString", "coordinates": geom["paths"]})
    } else if geom.get("x").is_some() && geom.get("y").is_some() {
        json!({"type": "Point", "coordinates": [geom["x"], geom["y"]]})
    } else {
        geom.clone()
    };
    let mut raw: Vec<[f64; 2]> = Vec::new();
    let push_pt = |c: &Value, out: &mut Vec<[f64; 2]>| {
        if let (Some(lon), Some(lat)) = (c.get(0).and_then(Value::as_f64), c.get(1).and_then(Value::as_f64)) {
            if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) {
                out.push([round_to(lat, 4), round_to(lon, 4)]);
            }
        }
    };
    match geom["type"].as_str() {
        Some("Point") => push_pt(&geom["coordinates"], &mut raw),
        Some("MultiPoint") | Some("LineString") => {
            for c in geom["coordinates"].as_array().into_iter().flatten() {
                push_pt(c, &mut raw);
            }
        }
        Some("MultiLineString") | Some("Polygon") => {
            for seg in geom["coordinates"].as_array().into_iter().flatten() {
                for c in seg.as_array().into_iter().flatten() {
                    push_pt(c, &mut raw);
                }
            }
        }
        Some("GeometryCollection") => {
            for g in geom["geometries"].as_array().into_iter().flatten() {
                if let Some((la, lo, ln)) = road_geometry(g) {
                    if ln.is_empty() {
                        raw.push([la, lo]);
                    } else {
                        raw.extend(ln);
                    }
                }
            }
        }
        _ => {}
    }
    if raw.is_empty() {
        return None;
    }
    let mid = raw[raw.len() / 2];
    if raw.len() < 2 || matches!(geom["type"].as_str(), Some("Point") | Some("MultiPoint")) {
        return Some((mid[0], mid[1], Vec::new()));
    }
    let mut line: Vec<[f64; 2]> = Vec::new();
    for p in &raw {
        let keep = match line.last() {
            None => true,
            Some(prev) => (p[0] - prev[0]).hypot(p[1] - prev[1]) >= 0.001,
        };
        if keep {
            line.push(*p);
            if line.len() >= 39 {
                break;
            }
        }
    }
    if let Some(&last) = raw.last() {
        if line.last() != Some(&last) {
            line.push(last);
        }
    }
    if line.len() < 2 {
        line.clear();
    }
    Some((mid[0], mid[1], line))
}

/// Every open road event from QLDTraffic's GeoJSON events FeatureCollection —
/// closures, flooding, crashes, works and hazards, each carrying the agency's
/// own reason — closed and higher-priority roads first (capped at 150).
pub fn parse_qld_roads(gj: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let et = p["event_type"].as_str().unwrap_or("");
        let sub = p["event_subtype"].as_str().unwrap_or("");
        let desc = p["description"].as_str().unwrap_or("");
        let due = p["event_due_to"].as_str().unwrap_or("");
        let Some((lat, lon, line)) = road_geometry(&f["geometry"]) else { continue };
        let id = match &p["id"] {
            Value::Number(n) => format!("qld:{}", n),
            Value::String(s) if !s.is_empty() => format!("qld:{}", s),
            _ => continue,
        };
        let road = p["road_summary"]["road_name"].as_str().unwrap_or("Road").trim().to_string();
        let loc = p["road_summary"]["locality"].as_str().unwrap_or("").trim().to_string();
        let lga = p["road_summary"]["local_government_area"].as_str().unwrap_or("").trim().to_string();
        let wh = if !loc.is_empty() { loc } else { lga };
        let imp_type = p["impact"]["impact_type"].as_str().unwrap_or("");
        let imp_sub = p["impact"]["impact_subtype"].as_str().unwrap_or("");
        // what the closure actually is, as the agency reports it: a full
        // closure, one closed to through traffic, a part closure, a
        // restriction (4WD only, a weight limit) or mere lane/water
        // impacts — all these had been flattened into "closed or not"
        let imp_l = imp_sub.to_lowercase();
        let level = if imp_l.contains("closed to all traffic") {
            "closed"
        } else if imp_l.contains("closed to through traffic") {
            "closed to through traffic"
        } else if imp_type.eq_ignore_ascii_case("Closures") {
            "part closed"
        } else if imp_l.contains("restricted") {
            "access restricted"
        } else if imp_l.contains("lane") || imp_l.contains("blocked") || imp_l.contains("affected") || imp_l.contains("single lane") {
            "lanes affected"
        } else {
            "caution"
        };
        let closed = level.starts_with("closed");
        let pri = p["event_priority"].as_str().unwrap_or("");
        let major = matches!(pri, "High" | "Extreme")
            || road.contains("Highway")
            || road.ends_with(" Hwy")
            || road.contains("Motorway");
        let summary = if !imp_sub.is_empty() && !desc.is_empty() {
            format!("{}: {}", imp_sub, desc)
        } else if !imp_sub.is_empty() {
            imp_sub.to_string()
        } else if !desc.is_empty() {
            desc.to_string()
        } else if !sub.is_empty() {
            sub.to_string()
        } else if !et.is_empty() {
            et.to_string()
        } else {
            "Road event".to_string()
        };
        let updated = p["last_updated"].as_str().or_else(|| p["duration"]["start"].as_str()).unwrap_or("");
        let hazard = if ["fire", "bushfire", "smoke"].iter().any(|w| format!("{} {} {} {}", et, sub, desc, due).to_lowercase().contains(w)) {
            Some("fire")
        } else {
            None
        };
        let mut item = json!({
            "id": id, "state": "QLD", "road": road, "where": wh,
            "desc": summary, "closed": closed, "level": level,
            "type": if !sub.is_empty() { sub } else if !et.is_empty() { et } else { "Event" },
            "due": due, "impact": imp_sub, "hazard": hazard,
            "major": major,
            "updated": updated, "lat": lat, "lon": lon,
            "link": "https://qldtraffic.qld.gov.au/",
        });
        if !line.is_empty() {
            item["line"] = json!(line);
        }
        out.push(item);
    }
    out.sort_by_key(|x| (!x["closed"].as_bool().unwrap_or(false), !x["major"].as_bool().unwrap_or(false), x["road"].as_str().unwrap_or("").to_string()));
    out.truncate(150);
    out
}

/// Flood-related road closures and hazards from Transport for NSW Live Traffic
/// (`flood-open.json` or `flood.json`).
pub fn parse_nsw_roads(gj: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        if p["ended"].as_bool() == Some(true) {
            continue;
        }
        let Some((lat, lon, line)) = road_geometry(&f["geometry"]) else { continue };
        let id = match &f["id"].as_i64().or_else(|| p["id"].as_i64()) {
            Some(n) => format!("nsw:{}", n),
            None => format!("nsw:{:.4},{:.4}", lat, lon),
        };
        let r0 = p["roads"].as_array().and_then(|a| a.first()).cloned().unwrap_or(Value::Null);
        let road = r0["mainStreet"].as_str().or_else(|| p["displayName"].as_str()).unwrap_or("Road").trim().to_string();
        let wh = r0["suburb"].as_str().or_else(|| r0["CrossStreet"].as_str()).unwrap_or("").trim().to_string();
        let head = p["headline"].as_str().unwrap_or("");
        let advice = p["adviceA"].as_str().unwrap_or("");
        let closed = head.to_lowercase().contains("closed") || advice.to_lowercase().contains("closed") || r0["impactedLanes"].as_array().is_some_and(|a| a.iter().any(|l| l["extent"].as_str().is_some_and(|s| s.to_lowercase().contains("closed"))));
        let major = p["isMajor"].as_bool() == Some(true) || road.contains("Highway") || road.ends_with(" Hwy") || road.contains("Motorway");
        let desc = if !head.is_empty() { head.to_string() } else { p["displayName"].as_str().unwrap_or("Flooding").to_string() };
        let updated = p["lastUpdated"].as_i64().or_else(|| p["created"].as_i64()).map(|ms| wmip_stamp(ms / 1000)).unwrap_or_default();
        let mut item = json!({
            "id": id, "state": "NSW", "road": road, "where": wh,
            "desc": desc, "closed": closed, "type": "Flooding",
            "major": major,
            "updated": updated, "lat": lat, "lon": lon,
            "link": "https://www.livetraffic.com/",
        });
        if !line.is_empty() {
            item["line"] = json!(line);
        }
        out.push(item);
    }
    out.sort_by_key(|x| (!x["closed"].as_bool().unwrap_or(false), !x["major"].as_bool().unwrap_or(false), x["road"].as_str().unwrap_or("").to_string()));
    out.truncate(150);
    out
}

/// Road closures and hazards from Main Roads WA's WebEOC ArcGIS FeatureServer.
pub fn parse_wa_roads(gj: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        let p = &f["attributes"];
        let Some((lat, lon, line)) = road_geometry(&f["geometry"]) else { continue };
        let id = match &p["Id"] {
            Value::Number(n) => format!("wa:{}", n),
            Value::String(s) if !s.is_empty() => format!("wa:{}", s),
            _ => continue,
        };
        let road = p["Road"].as_str().unwrap_or("Road").trim().to_string();
        let where_ = p["Suburb"].as_str().or_else(|| p["Region"].as_str()).unwrap_or("").trim().to_string();
        let incident = p["IncidentTy"].as_str().unwrap_or("").trim().to_string();
        let closure = p["ClosureTyp"].as_str().unwrap_or("").trim().to_string();
        let impact = p["TrafficImp"].as_str().unwrap_or("").trim().to_string();
        let closed = closure.to_lowercase().contains("closed");
        let level = if closed { "closed" } else { "caution" };
        let major = road.contains("Highway") || road.ends_with(" Hwy") || road.contains("Motorway");
        let updated = p["UpdateDate"].as_str().or_else(|| p["EntryDate"].as_str()).unwrap_or("").to_string();
        let hazard = if ["fire", "bushfire", "smoke"].iter().any(|w| incident.to_lowercase().contains(w)) { Some("fire") } else { None };
        let mut item = json!({
            "id": id, "state": "WA", "road": road, "where": where_,
            "desc": if !impact.is_empty() { impact.clone() } else { incident.clone() },
            "closed": closed, "level": level,
            "type": if incident.is_empty() { "Road event" } else { incident.as_str() },
            "due": impact, "impact": closure, "hazard": hazard,
            "major": major, "updated": updated, "lat": lat, "lon": lon,
            "link": "https://travelmap.mainroads.wa.gov.au/",
        });
        if !line.is_empty() { item["line"] = json!(line); }
        out.push(item);
    }
    out.sort_by_key(|x| (!x["closed"].as_bool().unwrap_or(false), !x["major"].as_bool().unwrap_or(false), x["road"].as_str().unwrap_or("").to_string()));
    out.truncate(150);
    out
}

/// Road closures and works from SA DIT Traffic SA (point features).
pub fn parse_sa_roads(gj: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        let p = &f["attributes"];
        let Some((lat, lon, line)) = road_geometry(&f["geometry"]) else { continue };
        let id = match &p["ROADWORKS_AND_INCIDENTS_ID"] {
            Value::String(s) if !s.is_empty() => format!("sa:{}", s),
            Value::Number(n) => format!("sa:{}", n),
            _ => continue,
        };
        let road = p["LOCAL_ROAD"].as_str().or_else(|| p["SIDE_STREET"].as_str()).unwrap_or("Road").trim().to_string();
        let where_ = p["SUBURB"].as_str().or_else(|| p["SIDE_STREET"].as_str()).unwrap_or("").trim().to_string();
        let desc = p["DESCRIPTION"].as_str().unwrap_or("").trim().to_string();
        let closed = desc.to_lowercase().contains("closed");
        let level = if closed { "closed" } else if p["NO_LANES_CLOSED"].as_str().map(|s| !s.trim().is_empty()).unwrap_or(false) { "lanes affected" } else { "caution" };
        let major = road.contains("Highway") || road.ends_with(" Hwy") || road.contains("Motorway");
        let updated = p["START_DATE_STRING"].as_str().unwrap_or("").to_string();
        let hazard = if ["fire", "bushfire", "smoke"].iter().any(|w| desc.to_lowercase().contains(w)) { Some("fire") } else { None };
        let mut item = json!({
            "id": id, "state": "SA", "road": road, "where": where_,
            "desc": if desc.is_empty() { "Road event".to_string() } else { desc.clone() },
            "closed": closed, "level": level,
            "type": p["REC_TYPE"].as_str().unwrap_or("Road event").trim().to_string(),
            "due": desc, "impact": p["TRAFFIC_DIR"].as_str().unwrap_or("").trim().to_string(),
            "hazard": hazard, "major": major, "updated": updated, "lat": lat, "lon": lon,
            "link": "https://www.traffic.sa.gov.au/",
        });
        if !line.is_empty() { item["line"] = json!(line); }
        out.push(item);
    }
    out.sort_by_key(|x| (!x["closed"].as_bool().unwrap_or(false), !x["major"].as_bool().unwrap_or(false), x["road"].as_str().unwrap_or("").to_string()));
    out.truncate(150);
    out
}

/// Obstructions and restrictions from Road Report NT.
pub fn parse_nt_roads(doc: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for o in doc["response"].as_array().into_iter().flatten() {
        let Some(start) = o["startPoint"].as_array() else { continue };
        if start.len() < 2 { continue; }
        let (Some(lat), Some(lon)) = (start[0].as_f64(), start[1].as_f64()) else { continue };
        let mut line = Vec::new();
        if let Some(end) = o["endPoint"].as_array() {
            if end.len() >= 2 {
                if let (Some(ela), Some(elo)) = (end[0].as_f64(), end[1].as_f64()) {
                    if (ela - lat).abs() > 1e-9 || (elo - lon).abs() > 1e-9 {
                        line.push([lat, lon]);
                        line.push([ela, elo]);
                    }
                }
            }
        }
        let id = format!("nt:{}", o["obstructionId"].as_i64().or_else(|| o["recordId"].as_i64()).unwrap_or(0));
        if id == "nt:0" { continue; }
        let road = o["roadName"].as_str().unwrap_or("Road").trim().to_string();
        let where_ = o["locationComment"].as_str().unwrap_or("").trim().to_string();
        let otype = o["obstructionType"].as_str().unwrap_or("").trim().to_string();
        let rtype = o["restrictionType"].as_str().unwrap_or("").trim().to_string();
        let comment = o["comment"].as_str().unwrap_or("").trim().to_string();
        let closed = format!("{} {}", otype, comment).to_lowercase().contains("closed");
        let level = if closed { "closed" } else { "access restricted" };
        let major = road.contains("Highway") || road.ends_with(" Hwy") || road.contains("Motorway");
        let hazard = if ["fire", "bushfire", "smoke"].iter().any(|w| format!("{} {}", otype, comment).to_lowercase().contains(w)) { Some("fire") } else { None };
        let mut item = json!({
            "id": id, "state": "NT", "road": road, "where": where_,
            "desc": if comment.is_empty() { otype.clone() } else { comment.clone() },
            "closed": closed, "level": level,
            "type": if otype.is_empty() { rtype.clone() } else { otype.clone() },
            "due": comment, "impact": otype, "hazard": hazard,
            "major": major, "updated": o["dateLastUpdated"].as_str().unwrap_or("").to_string(),
            "lat": lat, "lon": lon, "link": "https://roadreport.nt.gov.au/",
        });
        if line.len() >= 2 { item["line"] = json!(line); }
        out.push(item);
    }
    out.sort_by_key(|x| (!x["closed"].as_bool().unwrap_or(false), !x["major"].as_bool().unwrap_or(false), x["road"].as_str().unwrap_or("").to_string()));
    out.truncate(150);
    out
}

/// Road works from State Growth Tasmania (GeoServer WFS GeoJSON).
pub fn parse_tas_roads(gj: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let Some((lat, lon, line)) = road_geometry(&f["geometry"]) else { continue };
        let id = match &p["ID"] {
            Value::Number(n) => format!("tas:{}", n),
            Value::String(s) if !s.is_empty() => format!("tas:{}", s),
            _ => continue,
        };
        let road = p["ROAD_NAME"].as_str().unwrap_or("Road").trim().to_string();
        let where_ = p["LOCATION_DESC"].as_str().unwrap_or("").trim().to_string();
        let event_type = p["EVENT_TYPE"].as_str().unwrap_or("Roadworks").trim().to_string();
        let tm = p["TRAFFIC_MANAGEMENT"].as_str().unwrap_or("").trim().to_string();
        let closed = event_type.to_lowercase().contains("closure") || tm.to_lowercase().contains("closed");
        let level = if closed { "closed" } else if tm.to_lowercase().contains("lane") { "lanes affected" } else { "caution" };
        let major = road.contains("Highway") || road.ends_with(" Hwy") || road.contains("Motorway");
        let updated = p["START_TIME"].as_str().unwrap_or("").to_string();
        let mut item = json!({
            "id": id, "state": "TAS", "road": road, "where": where_,
            "desc": if where_.is_empty() { event_type.clone() } else { where_.clone() },
            "closed": closed, "level": level,
            "type": event_type, "due": tm, "impact": tm, "hazard": null,
            "major": major, "updated": updated, "lat": lat, "lon": lon,
            "link": p["WEB_LINK"].as_str().unwrap_or("https://www.transport.tas.gov.au/roadworks"),
        });
        if !line.is_empty() { item["line"] = json!(line); }
        out.push(item);
    }
    out.sort_by_key(|x| (!x["closed"].as_bool().unwrap_or(false), !x["major"].as_bool().unwrap_or(false), x["road"].as_str().unwrap_or("").to_string()));
    out.truncate(150);
    out
}

/// Temporary road closures from ACT (ArcGIS FeatureServer, point features).
pub fn parse_act_roads(gj: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        let p = &f["attributes"];
        let Some((lat, lon, line)) = road_geometry(&f["geometry"]) else { continue };
        let id = match &p["globalid"] {
            Value::String(s) if !s.is_empty() => format!("act:{}", s),
            _ => match &p["objectid"] { Value::Number(n) => format!("act:{}", n), _ => continue },
        };
        let title = p["projectTitle"].as_str().unwrap_or("").trim().to_string();
        let rtype = p["type"].as_str().unwrap_or("other").trim().to_string();
        let roads_closed = p["roadsClosed"].as_str().unwrap_or("").trim().to_string();
        let activity = p["describeActivity"].as_str().unwrap_or("").trim().to_string();
        let closed = roads_closed.to_lowercase().contains("closed");
        let level = if closed { "closed" } else { "caution" };
        let updated = p["startTimeClosure"].as_i64().map(|ms| wmip_stamp(ms / 1000)).unwrap_or_default();
        let desc = if roads_closed.is_empty() { title.clone() } else { roads_closed.clone() };
        let hazard = if ["fire", "bushfire", "smoke"].iter().any(|w| format!("{} {} {}", title, roads_closed, activity).to_lowercase().contains(w)) { Some("fire") } else { None };
        let mut item = json!({
            "id": id, "state": "ACT", "road": if title.is_empty() { "Road".to_string() } else { title.clone() },
            "where": if activity.is_empty() { title.clone() } else { activity.clone() },
            "desc": desc, "closed": closed, "level": level,
            "type": if rtype.is_empty() { "Road closure".to_string() } else { rtype },
            "due": roads_closed, "impact": roads_closed, "hazard": hazard,
            "major": false, "updated": updated, "lat": lat, "lon": lon,
            "link": "https://www.accesscanberra.act.gov.au/",
        });
        if !line.is_empty() { item["line"] = json!(line); }
        out.push(item);
    }
    out.sort_by_key(|x| (!x["closed"].as_bool().unwrap_or(false), !x["major"].as_bool().unwrap_or(false), x["road"].as_str().unwrap_or("").to_string()));
    out.truncate(150);
    out
}

/// Emergency warnings from the NSW RFS major incidents feed (public GeoJSON,
/// no key): points with ALERT LEVEL (Advice / Watch and Act / Emergency
/// Warning) and a TYPE/STATUS/SIZE/COUNCIL in the description. RFS is the
/// fire service, so hazard defaults to "fire" unless the text says flood.
pub fn parse_nsw_rfs_emergency(gj: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for f in gj["features"].as_array().into_iter().flatten() {
        let p = &f["properties"];
        let Some((lat, lon, _)) = road_geometry(&f["geometry"]) else { continue };
        let title = p["title"].as_str().unwrap_or("").trim().to_string();
        if title.is_empty() { continue; }
        let category = p["category"].as_str().unwrap_or("").trim().to_string();
        let level = match category.as_str() {
            "Advice" => "advice",
            "Watch and Act" => "watch_and_act",
            "Emergency Warning" => "emergency",
            _ => continue,
        };
        let desc = p["description"].as_str().unwrap_or("").to_string();
        let mut fields: std::collections::BTreeMap<String, String> = Default::default();
        for part in desc.split("<br />") {
            let part = part.trim();
            if let Some((k, v)) = part.split_once(':') {
                let k = k.trim().to_uppercase();
                let v = v.trim().to_string();
                if !v.is_empty() { fields.insert(k, v); }
            }
        }
        let hazard = if ["flood", "storm", "cyclone"].iter().any(|w| format!("{} {}", title, desc).to_lowercase().contains(w)) {
            "flood"
        } else {
            "fire"
        };
        let link = p["link"].as_str().unwrap_or("https://www.rfs.nsw.gov.au/fire-information/fires-near-me").to_string();
        let id = p["guid"].as_str().unwrap_or(&title).to_string();
        let updated = p["pubDate"].as_str().unwrap_or("").to_string();
        let status = fields.get("STATUS").cloned();
        let etype = fields.get("TYPE").cloned();
        let size = fields.get("SIZE").cloned();
        let council = fields.get("COUNCIL AREA").cloned();
        let location = fields.get("LOCATION").cloned().unwrap_or_else(|| title.clone());
        out.push(json!({
            "id": id, "state": "NSW", "level": level, "hazard": hazard,
            "title": title, "action": null,
            "status": status, "type": etype, "size": size, "council": council,
            "location": location, "point": [lat, lon],
            "updated": updated, "link": link,
            "source": "NSW RFS",
        }));
    }
    out
}

#[cfg(test)]
mod road_and_rain_obs_tests {

    use super::*;

    #[test]
    fn rain_popups_and_watch_list() {
        let html = r#"<map name="IDQ65326.html">
 <area onmouseover="javascript:PopupRain(&quot;Natural Bridge&quot;,'540837','-28.1988','153.2308','126.0','24','hour')"/>
 <area onmouseover="javascript:PopupRain(&quot;Tewantin RSL Park&quot;,'040908','-26.3911','153.0403','20.0','24','hour')"/>
 <area onmouseover="javascript:PopupRain(&quot;Natural Bridge&quot;,'540837','-28.1988','153.2308','42.0','6','hour')"/>
</map>"#;
        let p = parse_rain_popups(html);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0]["station"], "540837");
        assert_eq!(p[0]["mm"], 126.0);
        assert_eq!(p[0]["hours"], 24);
        assert_eq!(p[1]["station"], "40908", "leading zero stripped");
        let doc = json!({
            "rainObs": {
                "540837": {"name": "Natural Bridge", "lat": -28.1988, "lon": 153.2308, "mm24h": 126.0, "mm6h": 42.0},
                "40908": {"name": "Tewantin RSL Park", "lat": -26.3911, "lon": 153.0403, "mm24h": 20.0},
            }
        });
        let w = watch_list(&doc);
        let arr = w.as_array().unwrap();
        assert_eq!(arr.len(), 1, "only >= 100 mm/24h on watch list");
        assert_eq!(arr[0]["kind"], "rainObs");
        assert_eq!(arr[0]["station"], "540837");
        assert!(arr[0]["why"][0].as_str().unwrap().contains("126 mm"));
    }

    #[test]
    fn qld_and_nsw_road_events() {
        let qld = json!({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "LineString", "coordinates": [[148.5, -28.0], [148.55, -28.05]]},
                    "properties": {
                        "id": 717127,
                        "event_type": "Flooding",
                        "event_subtype": "Long-term flooding",
                        "event_priority": "High",
                        "description": "Bridge underwater",
                        "impact": {"impact_type": "Closures", "impact_subtype": "Road closed to all traffic"},
                        "road_summary": {"road_name": "Carnarvon Highway", "locality": "St George"},
                        "last_updated": "2026-10-22T04:00:00+10:00"
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [153.0, -27.5]},
                    "properties": {
                        "id": 100,
                        "event_type": "Roadworks",
                        "event_subtype": "Planned roadworks",
                        "road_summary": {"road_name": "Gympie Road", "locality": "Chermside"}
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [153.1, -27.6]},
                    "properties": {
                        "id": 101,
                        "event_type": "Flooding",
                        "event_subtype": "Long-term flooding",
                        "description": "Road is open to local traffic only",
                        "impact": {"impact_type": "Closures", "impact_subtype": "Road closed to through traffic"},
                        "road_summary": {"road_name": "Kennedy Highway", "locality": "Kuranda"}
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [153.2, -27.7]},
                    "properties": {
                        "id": 102,
                        "event_type": "Flooding",
                        "event_subtype": "Flash flooding",
                        "description": "Water over the road",
                        "impact": {"impact_type": "Closures", "impact_subtype": "Partial lane closures"},
                        "road_summary": {"road_name": "Muller Road", "locality": "Redland Bay"}
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [152.9, -27.4]},
                    "properties": {
                        "id": 103,
                        "event_type": "Flooding",
                        "event_subtype": "Long-term flooding",
                        "description": "Unsealed road flooded",
                        "impact": {"impact_type": "Road restricted", "impact_subtype": "Restricted to four wheel drive vehicles only"},
                        "road_summary": {"road_name": "Conondale Range Road", "locality": "Conondale"}
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [152.8, -27.3]},
                    "properties": {
                        "id": 104,
                        "event_type": "Flooding",
                        "event_subtype": "Flash flooding",
                        "description": "Water over the road at the causeway",
                        "impact": {"impact_type": "Lanes affected", "impact_subtype": "All lanes affected"},
                        "road_summary": {"road_name": "Bowen Street", "locality": "Gympie"}
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [152.7, -27.2]},
                    "properties": {
                        "id": 105,
                        "event_type": "Hazard",
                        "event_subtype": "Adverse driving conditions",
                        "event_due_to": "Water over road",
                        "description": "Take care on this road",
                        "impact": {"impact_type": "No blockage"},
                        "road_summary": {"road_name": "Kenilworth Road", "locality": "Kenilworth"}
                    }
                },
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [152.6, -27.1]},
                    "properties": {
                        "id": 106,
                        "event_type": "Hazard",
                        "event_subtype": "Adverse driving conditions",
                        "event_due_to": "Rough surface",
                        "description": "Gravel road damage",
                        "impact": {"impact_type": "No blockage"},
                        "road_summary": {"road_name": "Sunday Creek Road", "locality": "Sunday Creek"}
                    }
                }
            ]
        });
        let items = parse_qld_roads(&qld);
        assert_eq!(items.len(), 8, "every event kept, flood or not");
        let carnarvon = items.iter().find(|x| x["id"] == "qld:717127").unwrap();
        assert_eq!(carnarvon["road"], "Carnarvon Highway");
        assert_eq!(carnarvon["where"], "St George");
        assert_eq!(carnarvon["closed"], true);
        assert_eq!(carnarvon["major"], true);
        assert_eq!(carnarvon["type"], "Long-term flooding", "the agency's event subtype passes through");
        assert_eq!(carnarvon["impact"], "Road closed to all traffic");
        assert_eq!(carnarvon["line"].as_array().unwrap().len(), 2);
        // roadworks and hazards of any kind are in too
        let works = items.iter().find(|x| x["id"] == "qld:100").unwrap();
        assert_eq!(works["type"], "Planned roadworks", "the event type passes through when there is no subtype-matched name");
        assert_eq!(works["closed"], false);
        assert_eq!(works["level"], "caution");
        let through = items.iter().find(|x| x["id"] == "qld:101").unwrap();
        assert_eq!(through["closed"], true, "through-traffic closures count as closed");
        assert_eq!(through["level"], "closed to through traffic");
        let partial = items.iter().find(|x| x["id"] == "qld:102").unwrap();
        assert_eq!(partial["closed"], false, "a partial lane closure is not a full road closure");
        assert_eq!(partial["level"], "part closed");
        let restricted = items.iter().find(|x| x["id"] == "qld:103").unwrap();
        assert_eq!(restricted["closed"], false);
        assert_eq!(restricted["level"], "access restricted");
        assert_eq!(restricted["impact"], "Restricted to four wheel drive vehicles only");
        let lanes = items.iter().find(|x| x["id"] == "qld:104").unwrap();
        assert_eq!(lanes["closed"], false, "lanes affected is not closed to all traffic");
        assert_eq!(lanes["level"], "lanes affected");
        // the agency records why, in event_due_to — for floods and for
        // every other kind of hazard alike
        let water = items.iter().find(|x| x["id"] == "qld:105").unwrap();
        assert_eq!(water["due"], "Water over road", "the reason passes through");
        assert_eq!(water["level"], "caution");
        let rough = items.iter().find(|x| x["id"] == "qld:106").unwrap();
        assert_eq!(rough["due"], "Rough surface", "a non-flood reason is kept too");
        assert_eq!(rough["type"], "Adverse driving conditions");
        assert_eq!(rough["level"], "caution");

        let nsw = json!({
            "type": "FeatureCollection",
            "features": [{
                "id": 99,
                "geometry": {"type": "Point", "coordinates": [153.28, -28.81]},
                "properties": {
                    "headline": "ROAD CLOSED Flooding",
                    "displayName": "Bruxner Highway",
                    "isMajor": true,
                    "roads": [{"mainStreet": "Bruxner Highway", "suburb": "Lismore"}]
                }
            }]
        });
        let nitems = parse_nsw_roads(&nsw);
        assert_eq!(nitems.len(), 1);
        assert_eq!(nitems[0]["id"], "nsw:99");
        assert_eq!(nitems[0]["closed"], true);
        assert_eq!(nitems[0]["major"], true);
        assert_eq!(nitems[0]["type"], "Flooding", "the whole NSW feed is flood hazards");

        let w = watch_list(&json!({"roads": {"items": items}}));
        assert_eq!(w.as_array().unwrap()[0]["kind"], "road");
        assert_eq!(w.as_array().unwrap()[0]["name"], "Carnarvon Highway (St George)");
    }
}
