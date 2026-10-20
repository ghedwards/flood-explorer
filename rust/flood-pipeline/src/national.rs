//! National Bureau of Meteorology flood gauges, water storages and their
//! latest readings (was pipeline/fetch_national.py).
//!
//! Usage: flood national <out_dir>
//!
//! Writes gauges.geojson, gauges.min.json (and -core / -river halves),
//! storages.geojson, readings.json and meta.json.

use crate::net;
use crate::obj;
use crate::util::*;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

pub const BOM_GIS: &str = "https://hosting.wsapi.cloud.bom.gov.au/arcgis/rest/services/";
pub const KIWIS: &str = "https://www.bom.gov.au/waterdata/services";
pub const DAILY: &str = "DMQaQc.Merged.DailyMean.24HR";
/// Hourly means: as recent as the raw readings (Water Data Online runs
/// about a day behind either way) at a quarter of the data; the latest one
/// is the "level now" for river gauges (daily means stay as the history).
pub const HOURLY: &str = "DMQaQc.Merged.HourlyMean.HR";
const GAUGE_LAYERS: [(u32, &str); 3] = [(2, "forecast"), (3, "information"), (5, "river-tide")];

fn nfgn() -> String {
    format!("{}flood/National_Flood_Gauge_Network/FeatureServer/", BOM_GIS)
}
fn storages_url() -> String {
    format!("{}Australia_Water_Storages/FeatureServer/0", BOM_GIS)
}

/// The network call: (url, query parameters) -> JSON.
pub type HttpJson<'a> = &'a dyn Fn(&str, &[(String, String)]) -> R<Value>;

/// The real one: three tries, 5 s and 10 s apart, two-minute timeout.
pub fn http_json(url: &str, params: &[(String, String)]) -> R<Value> {
    let full = net::with_query(url, params);
    let mut last = String::new();
    for attempt in 0..3 {
        match net::get(&full, &[], 120) {
            Ok(r) => match serde_json::from_slice(&r.body) {
                Ok(v) => return Ok(v),
                Err(e) => last = e.to_string(),
            },
            Err(e) => last = e.to_string(),
        }
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_secs(5 * (attempt as u64 + 1)));
        }
    }
    Err(format!("{}: {}", clip(&full, 120), last))
}

fn p(k: &str, v: impl ToString) -> (String, String) {
    (k.to_string(), v.to_string())
}

/// Page through an ArcGIS feature layer as GeoJSON features.
pub fn query_all(http: HttpJson, layer_url: &str, out_fields: &str) -> R<Vec<Value>> {
    let mut feats = Vec::new();
    let mut offset = 0usize;
    loop {
        let res = http(&format!("{}/query", layer_url), &[
            p("where", "1=1"), p("outFields", out_fields), p("outSR", 4326), p("f", "geojson"),
            p("resultOffset", offset), p("resultRecordCount", 2000), p("orderByFields", "objectid"),
        ])?;
        let batch = arr(res.get("features")).to_vec();
        let more = truthy(res.get("exceededTransferLimit")) || truthy(res.get("properties").and_then(|p| p.get("exceededTransferLimit")));
        let n = batch.len();
        feats.extend(batch);
        if n == 0 || !more {
            return Ok(feats);
        }
        offset += n;
    }
}

fn gauge_kind(p: &Value, layer_kind: &str) -> &'static str {
    let text = ["location_types", "forecast_site_classification"].iter().map(|k| s_or_empty(p.get(*k))).collect::<Vec<_>>().join(" ").to_lowercase();
    if text.contains("tide") {
        return "tide";
    }
    match layer_kind {
        "forecast" => return "forecast",
        "information" => return "information",
        _ => {}
    }
    if text.contains("forecast") {
        "forecast"
    } else if text.contains("information") {
        "information"
    } else {
        "river"
    }
}

fn rank(k: &str) -> i32 {
    match k {
        "forecast" => 3,
        "information" => 2,
        "tide" => 1,
        _ => 0,
    }
}

pub fn build_gauges(http: HttpJson, errors: &mut Vec<String>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for (layer, kind) in GAUGE_LAYERS {
        let feats = match query_all(http, &format!("{}{}", nfgn(), layer), "*") {
            Ok(f) => f,
            Err(e) => {
                errors.push(format!("gauge layer {}: {}", layer, e));
                continue;
            }
        };
        for f in feats {
            let pr = f.get("properties").cloned().unwrap_or(json!({}));
            let g = match f.get("geometry") {
                Some(g) if truthy(Some(g)) => g.clone(),
                _ => continue,
            };
            let key = or_v(Some(&or_v(pr.get("bom_stn_num"), pr.get("awrc_stateid"))), pr.get("objectid"));
            let k = gauge_kind(&pr, kind);
            let id = py_str(&key);
            let props = obj! {
                "id" => id.clone(),
                "station" => s_or_empty(pr.get("awrc_stateid")).trim(),
                "bom" => pr.get("bom_stn_num").cloned().unwrap_or(Value::Null),
                "name" => s_or_empty(pr.get("name")).trim(),
                "state" => pr.get("state").cloned().unwrap_or(Value::Null),
                "basin" => pr.get("basin").cloned().unwrap_or(Value::Null),
                "agency" => pr.get("agency").cloned().unwrap_or(Value::Null),
                "types" => pr.get("location_types").cloned().unwrap_or(Value::Null),
                "kind" => k,
            };
            let replace = match by_id.get(&id) {
                None => {
                    order.push(id.clone());
                    true
                }
                Some(old) => rank(k) > rank(old["properties"]["kind"].as_str().unwrap_or("")),
            };
            if replace {
                by_id.insert(id, obj! {"type" => "Feature", "geometry" => g, "properties" => props});
            }
        }
    }
    order.into_iter().map(|id| by_id.remove(&id).unwrap()).collect()
}

pub fn build_storages(http: HttpJson, errors: &mut Vec<String>) -> Vec<Value> {
    let fields = ["wstorname", "wstorurl", "storage_id", "wiski_station_no", "total_capacity_ml", "accessible_capacity_ml", "river_name", "state_name", "data_owner", "year_completion", "objectid"].join(",");
    let feats = match query_all(http, &storages_url(), &fields) {
        Ok(f) => f,
        Err(e) => {
            errors.push(format!("storages: {}", e));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for f in feats {
        if !truthy(f.get("geometry")) {
            continue;
        }
        let pr = f.get("properties").cloned().unwrap_or(json!({}));
        let g = |k: &str| pr.get(k).cloned().unwrap_or(Value::Null);
        out.push(obj! {"type" => "Feature", "geometry" => f["geometry"].clone(), "properties" => obj! {
            "id" => py_str(&or_v(pr.get("storage_id"), pr.get("objectid"))),
            "station" => s_or_empty(pr.get("wiski_station_no")).trim(),
            "name" => s_or_empty(pr.get("wstorname")).trim(),
            "river" => g("river_name"),
            "state" => g("state_name"),
            "owner" => g("data_owner"),
            "capacity_ml" => or_v(pr.get("accessible_capacity_ml"), pr.get("total_capacity_ml")),
            "total_capacity_ml" => g("total_capacity_ml"),
            "year" => g("year_completion"),
            "url" => g("wstorurl"),
            "kind" => "storage",
        }});
    }
    out
}

/// A Water Data Online (KiWIS) query.
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

pub fn kiwis(params: &[(String, String)]) -> R<Value> {
    kiwis_with(&http_json, params)
}

/// Pairs for a KiWIS query.
pub fn kp(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// A KiWIS table ([[header...], [row...], ...]): the column index of a name.
pub fn col(header: &Value, name: &str) -> Option<usize> {
    header.as_array()?.iter().position(|h| h.as_str() == Some(name))
}

fn timeseries_ids(http: HttpJson, parameter: &str, ts_name: &str, errors: &mut Vec<String>) -> Vec<(String, String)> {
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

fn latest_values(http: HttpJson, ids: &[String], period: &str, errors: &mut Vec<String>) -> HashMap<String, Vec<Value>> {
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

fn readings_for(http: HttpJson, features: &[Value], parameter: &str, unit: &str, hourly: bool, errors: &mut Vec<String>) -> Value {
    let wanted: HashSet<String> = features.iter().filter_map(|f| f["properties"]["station"].as_str()).filter(|s| !s.is_empty()).map(String::from).collect();
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
    Value::Object(out)
}

/// Point features as columns: {keys, dict, rows: [[lon, lat, v...]]}.
/// Columns with few distinct string values are stored as indexes.
pub fn compact(features: &[Value]) -> Value {
    let mut keys: Vec<String> = features.iter().filter_map(|f| f.get("properties").and_then(|p| p.as_object())).flat_map(|p| p.keys().cloned()).collect::<HashSet<_>>().into_iter().collect();
    keys.sort();
    let val = |f: &Value, k: &str| f.get("properties").and_then(|p| p.get(k)).cloned().unwrap_or(Value::Null);
    let mut dicts: Vec<(String, Vec<String>)> = Vec::new();
    let limit = 50usize.max(features.len() / 8);
    for k in &keys {
        let mut uniq: Vec<Value> = Vec::new();
        for f in features {
            let v = val(f, k);
            if !v.is_null() && !uniq.contains(&v) {
                uniq.push(v);
            }
        }
        if !uniq.is_empty() && uniq.len() <= limit && uniq.iter().all(|v| v.is_string()) {
            dicts.push((k.clone(), uniq.into_iter().map(|v| v.as_str().unwrap().to_string()).collect()));
        }
    }
    let rows: Vec<Value> = features
        .iter()
        .map(|f| {
            let c = f.get("geometry").and_then(|g| g.get("coordinates"));
            let x = c.and_then(|c| c.get(0)).cloned().unwrap_or(Value::Null);
            let y = c.and_then(|c| c.get(1)).cloned().unwrap_or(Value::Null);
            let mut row = vec![x, y];
            for k in &keys {
                let v = val(f, k);
                match dicts.iter().find(|d| &d.0 == k) {
                    Some((_, d)) => {
                        let i = v.as_str().and_then(|s| d.iter().position(|x| x == s)).map_or(-1, |i| i as i64);
                        row.push(json!(i));
                    }
                    None => row.push(v),
                }
            }
            Value::Array(row)
        })
        .collect();
    let mut dm = Map::new();
    for (k, d) in dicts {
        dm.insert(k, json!(d));
    }
    obj! {"keys" => keys, "dict" => Value::Object(dm), "rows" => rows}
}

pub fn run(out_dir: &str, http: HttpJson) -> R<String> {
    let out = Path::new(out_dir);
    std::fs::create_dir_all(out).map_err(err)?;
    let mut errors = Vec::new();
    let mut gauges = build_gauges(http, &mut errors);
    let mut storages = build_storages(http, &mut errors);
    let readings = obj! {
        "level" => readings_for(http, &gauges, "Water Course Level", "m", true, &mut errors),
        "storage" => readings_for(http, &storages, "Storage Volume", "ML", false, &mut errors),
        "series" => DAILY,
    };
    // about a metre is plenty for map points
    for f in gauges.iter_mut().chain(storages.iter_mut()) {
        if let Some(g) = f.get_mut("geometry") {
            if g.get("type").and_then(|t| t.as_str()) == Some("Point") {
                if let Some(c) = g.get("coordinates").and_then(|c| c.as_array()).filter(|c| !c.is_empty()) {
                    let r: Vec<Value> = c.iter().take(2).map(|v| num(round_to(v.as_f64().unwrap_or(f64::NAN), 5))).collect();
                    g["coordinates"] = Value::Array(r);
                }
            }
        }
    }
    let kind_of = |f: &Value| f["properties"]["kind"].as_str().unwrap_or("").to_string();
    write_json(out.join("gauges.geojson"), &obj! {"type" => "FeatureCollection", "features" => gauges.clone()})?;
    write_json(out.join("gauges.min.json"), &compact(&gauges))?;
    let core: Vec<Value> = gauges.iter().filter(|f| kind_of(f) != "river").cloned().collect();
    let rest: Vec<Value> = gauges.iter().filter(|f| kind_of(f) == "river").cloned().collect();
    write_json(out.join("gauges-core.min.json"), &compact(&core))?;
    write_json(out.join("gauges-river.min.json"), &compact(&rest))?;
    write_json(out.join("storages.geojson"), &obj! {"type" => "FeatureCollection", "features" => storages.clone()})?;
    write_json(out.join("readings.json"), &readings)?;
    let mut kinds = Map::new();
    for g in &gauges {
        let k = kind_of(g);
        let n = kinds.get(&k).and_then(|v| v.as_i64()).unwrap_or(0);
        kinds.insert(k, json!(n + 1));
    }
    let nl = readings["level"].as_object().map_or(0, |o| o.len());
    let ns = readings["storage"].as_object().map_or(0, |o| o.len());
    let kinds_txt = format!("{{{}}}", kinds.iter().map(|(k, v)| format!("'{}': {}", k, v)).collect::<Vec<_>>().join(", "));
    let meta = obj! {
        "fetched" => now_iso(), "gauges" => gauges.len(), "gaugeKinds" => Value::Object(kinds), "storages" => storages.len(),
        "levelReadings" => nl, "storageReadings" => ns, "errors" => errors.clone(),
        "attribution" => "© Commonwealth of Australia (Bureau of Meteorology)",
    };
    write_json_indent(out.join("meta.json"), &meta, 1)?;
    let mut msg = format!("National: {} gauges {}, {} storages, {} level readings, {} storage readings, {} errors", gauges.len(), kinds_txt, storages.len(), nl, ns, errors.len());
    for e in errors.iter().take(5) {
        msg.push_str(&format!("\nwarning: {}", e));
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(lon: f64, lat: f64, props: Value) -> Value {
        json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props})
    }

    fn param<'a>(ps: &'a [(String, String)], k: &str) -> Option<&'a str> {
        ps.iter().find(|x| x.0 == k).map(|x| x.1.as_str())
    }

    fn fake(url: &str, ps: &[(String, String)]) -> R<Value> {
        if url.contains("Water_Storages") {
            return Ok(json!({"type": "FeatureCollection", "features": [pt(152.6, -27.4, json!({"storage_id": 1, "wstorname": "Wivenhoe Dam", "wiski_station_no": "143001A",
                "accessible_capacity_ml": 1165240, "total_capacity_ml": 1165240, "river_name": "Brisbane River", "state_name": "Queensland", "data_owner": "Seqwater"}))]}));
        }
        if url.contains("/FeatureServer/") && url.ends_with("/query") {
            let layer: u32 = url.split("/FeatureServer/").nth(1).unwrap().split('/').next().unwrap().parse().unwrap();
            if param(ps, "resultOffset") != Some("0") {
                return Ok(json!({"type": "FeatureCollection", "features": []}));
            }
            return Ok(match layer {
                2 => json!({"type": "FeatureCollection", "properties": {"exceededTransferLimit": true}, "features": [pt(153.03, -27.47, json!({"bom_stn_num": 540198, "awrc_stateid": "540198", "name": "Brisbane City",
                    "location_types": "Forecast Location", "forecast_site_classification": "Forecast", "basin": "Brisbane River"}))]}),
                3 => json!({"type": "FeatureCollection", "features": [pt(152.9, -27.55, json!({"bom_stn_num": 540100, "awrc_stateid": "143001C", "name": "Moggill",
                    "location_types": "Information Location", "forecast_site_classification": "Information"}))]}),
                _ => json!({"type": "FeatureCollection", "features": [
                    pt(153.03, -27.47, json!({"bom_stn_num": 540198, "awrc_stateid": "540198", "name": "Brisbane City", "location_types": "River Gauge"})),
                    pt(153.17, -27.37, json!({"bom_stn_num": 540683, "awrc_stateid": "540683", "name": "Brisbane Bar", "location_types": "Tide Gauge"}))]}),
            });
        }
        if url == KIWIS {
            match param(ps, "request") {
                Some("getTimeseriesList") => {
                    return Ok(if param(ps, "parametertype_name") == Some("Water Course Level") && param(ps, "ts_name") == Some(HOURLY) {
                        json!([["station_no", "ts_id"], ["540198", "511"]])
                    } else if param(ps, "parametertype_name") == Some("Water Course Level") {
                        json!([["station_no", "ts_id"], ["540198", "111"], ["999999", "222"]])
                    } else {
                        json!([["station_no", "ts_id"], ["143001A", "333"]])
                    })
                }
                Some("getTimeseriesValues") => {
                    let mut out = Vec::new();
                    for i in param(ps, "ts_id").unwrap().split(',') {
                        let v = match i {
                            "111" => json!([["2026-10-12T00:00:00.000+10:00", 1.1], ["2026-10-13T00:00:00.000+10:00", 1.3]]),
                            "333" => json!([["2026-10-13T00:00:00.000+10:00", 900000.0]]),
                            "511" => json!([["2026-10-13T17:00:00.000+10:00", 1.42], ["2026-10-13T18:00:00.000+10:00", 1.45]]),
                            _ => continue,
                        };
                        out.push(json!({"ts_id": i, "columns": "Timestamp,Value", "data": v}));
                    }
                    return Ok(Value::Array(out));
                }
                _ => {}
            }
        }
        panic!("unexpected request {} {:?}", url, ps)
    }

    #[test]
    fn fetch_with_mocked_services() {
        let d = std::env::temp_dir().join(format!("nat-{}", std::process::id()));
        run(d.to_str().unwrap(), &fake).unwrap();
        let gauges = read_json(d.join("gauges.geojson")).unwrap()["features"].as_array().unwrap().clone();
        let storages = read_json(d.join("storages.geojson")).unwrap();
        let readings = read_json(d.join("readings.json")).unwrap();
        let meta = read_json(d.join("meta.json")).unwrap();
        assert_eq!(gauges.len(), 3, "Brisbane City de-duplicated");
        let by = |n: &str| gauges.iter().find(|g| g["properties"]["name"] == n).unwrap()["properties"].clone();
        assert_eq!(by("Brisbane City")["kind"], "forecast");
        assert_eq!(by("Moggill")["kind"], "information");
        assert_eq!(by("Brisbane Bar")["kind"], "tide");
        assert_eq!(by("Brisbane City")["id"], "540198");
        assert_eq!(storages["features"][0]["properties"]["name"], "Wivenhoe Dam");
        assert_eq!(readings["level"]["540198"]["latest"][1], 1.45, "the newer hourly mean is the level now");
        assert_eq!(readings["level"]["540198"]["latestKind"], "hourly");
        assert_eq!(readings["level"]["540198"]["series"].as_array().unwrap().len(), 2, "daily history kept");
        assert_eq!(readings["storage"]["143001A"]["latestKind"], "daily");
        assert!(readings["level"].get("999999").is_none(), "not a mapped gauge");
        assert_eq!(readings["storage"]["143001A"]["latest"][1], 900000.0);
        assert_eq!(meta["errors"], json!([]));
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn kiwis_timestamps_compare_across_time_zones() {
        assert_eq!(ts_epoch("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(ts_epoch("1970-01-01T10:00:00.000+10:00"), Some(0));
        let qld = ts_epoch("2026-10-19T18:00:00.000+10:00").unwrap();
        let wa = ts_epoch("2026-10-19T16:00:00.000+08:00").unwrap();
        let sa = ts_epoch("2026-10-19T17:30:00.000+09:30").unwrap();
        assert_eq!(qld, wa);
        assert_eq!(qld, sa);
        assert!(ts_epoch("2026-10-19T00:00:00.000+10:00").unwrap() < qld);
    }

    #[test]
    fn failures_are_recorded_not_fatal() {
        let d = std::env::temp_dir().join(format!("nat-broken-{}", std::process::id()));
        run(d.to_str().unwrap(), &|_: &str, _: &[(String, String)]| -> R<Value> { Err("blocked".into()) }).unwrap();
        let meta = read_json(d.join("meta.json")).unwrap();
        assert_eq!(meta["gauges"], 0);
        assert!(!meta["errors"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn compact_gauges_keep_every_value() {
        let feats: Vec<Value> = (0..60)
            .map(|i| json!({"type": "Feature", "geometry": {"type": "Point", "coordinates": [150.0 + i as f64 * 0.01, -27.0]},
                "properties": {"id": i.to_string(), "name": format!("G{}", i), "state": if i % 2 == 1 { "QLD" } else { "NSW" }, "kind": "river", "bom": null}}))
            .collect();
        let c = compact(&feats);
        assert!(c["dict"].get("state").is_some());
        assert!(c["dict"].get("name").is_none(), "unique names stay inline");
        let keys: Vec<&str> = c["keys"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        let k = |n: &str| keys.iter().position(|x| *x == n).unwrap() + 2;
        let row = &c["rows"][3];
        assert_eq!(c["dict"]["state"][row[k("state")].as_u64().unwrap() as usize], "QLD");
        assert_eq!(row[k("name")], "G3");
        assert_eq!(row[0], 150.03);
        assert_eq!(row[1], -27.0);
    }
}
