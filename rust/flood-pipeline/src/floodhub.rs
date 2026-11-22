//! Google Flood Hub forecasts (was pipeline/fetch_floodhub.py).
//!
//! Usage: FLOOD_FORECASTING_API_KEY=... flood floodhub <config.json> <data_dir>
//!
//! Writes floodhub.json (gauges, latest flood status, thresholds,
//! forecasts, flash-flood events) and floodhub.geojson (forecast flood
//! areas and flash-flood areas). Without a key it writes a "not connected"
//! file so the viewer can explain how to switch the feed on.

use crate::net::{self, NetErr};
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::Path;

const BASE: &str = "https://floodforecasting.googleapis.com/v1/";
const ATTRIBUTION: &str = "Flood forecasts: Google Flood Hub (CC BY 4.0)";
const ACTIVE: [&str; 3] = ["ABOVE_NORMAL", "SEVERE", "EXTREME"];

/// (method, path, query parameters, JSON body) -> JSON
pub type Req<'a> = &'a dyn Fn(&str, &str, &[(String, String)], Option<&Value>) -> R<Value>;

#[expect(clippy::type_complexity, reason = "Returned closure matches the Req transport signature above")]
pub fn real_req(key: String) -> impl Fn(&str, &str, &[(String, String)], Option<&Value>) -> R<Value> {
    move |method, path, params, body| {
        let url = if params.is_empty() {
            format!("{}{}", BASE, path)
        } else {
            format!("{}{}?{}", BASE, path, net::urlencode(params))
        };
        let data = body.map(|b| b.to_string());
        let headers = [("Content-Type", "application/json"), ("X-Goog-Api-Key", key.as_str())];
        match net::request(method, &url, &headers, data.as_deref().map(|s| s.as_bytes()), 60) {
            Ok(r) => {
                if r.body.is_empty() {
                    return Ok(json!({}));
                }
                serde_json::from_slice(&r.body).map_err(err)
            }
            Err(NetErr::Status(c, detail)) => Err(format!("{} {} -> HTTP {}: {}", method, path, c, clip(&detail, 300))),
            Err(e) => Err(e.to_string()),
        }
    }
}

struct Api<'a> {
    req: Req<'a>,
    calls: Cell<usize>,
}

impl<'a> Api<'a> {
    fn get(&self, path: &str, params: &[(String, String)]) -> R<Value> {
        self.calls.set(self.calls.get() + 1);
        (self.req)("GET", path, params, None)
    }
    fn post(&self, path: &str, body: &Value) -> R<Value> {
        self.calls.set(self.calls.get() + 1);
        (self.req)("POST", path, &[], Some(body))
    }
    fn paged(&self, path: &str, body: &Value, key: &str) -> R<Vec<Value>> {
        let (mut out, mut token): (Vec<Value>, Option<Value>) = (Vec::new(), None);
        loop {
            let mut b = body.clone();
            if let Some(t) = &token {
                b["pageToken"] = t.clone();
            }
            let res = self.post(path, &b)?;
            out.extend(arr(res.get(key)).iter().cloned());
            token = res.get("nextPageToken").filter(|t| truthy(Some(t))).cloned();
            if token.is_none() {
                return Ok(out);
            }
        }
    }
}

/// A counter-clockwise loop (as S2 expects) around [west, south, east, north].
pub fn region_loop(bbox: &[f64]) -> Value {
    let (w, s, e, n) = (bbox[0], bbox[1], bbox[2], bbox[3]);
    let pts = [(s, w), (s, e), (n, e), (n, w)];
    json!({"vertices": pts.iter().map(|(la, lo)| json!({"latitude": la, "longitude": lo})).collect::<Vec<_>>()})
}

/// A Flood Hub KML polygon string as a GeoJSON geometry.
pub fn kml_to_geometry(kml: &str) -> Option<Value> {
    static POLY: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static COORDS: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let poly = POLY.get_or_init(|| Regex::new(r"(?s)<(?:\w+:)?Polygon\b[^>]*>(.*?)</(?:\w+:)?Polygon>").unwrap());
    let coords = COORDS.get_or_init(|| Regex::new(r"(?s)<(?:\w+:)?coordinates\b[^>]*>(.*?)</(?:\w+:)?coordinates>").unwrap());
    let mut polys = Vec::new();
    for p in poly.captures_iter(kml) {
        let mut rings = Vec::new();
        for c in coords.captures_iter(&p[1]) {
            let mut ring = Vec::new();
            for tok in c[1].split_whitespace() {
                let parts: Vec<&str> = tok.split(',').collect();
                if parts.len() >= 2 {
                    if let (Ok(x), Ok(y)) = (parts[0].parse::<f64>(), parts[1].parse::<f64>()) {
                        ring.push(json!([num(round_to(x, 6)), num(round_to(y, 6))]));
                    }
                }
            }
            if ring.len() >= 4 {
                rings.push(Value::Array(ring));
            }
        }
        if !rings.is_empty() {
            polys.push(Value::Array(rings));
        }
    }
    match polys.len() {
        0 => None,
        1 => Some(json!({"type": "Polygon", "coordinates": polys[0]})),
        _ => Some(json!({"type": "MultiPolygon", "coordinates": polys})),
    }
}

fn geometry_bbox(geom: &Value) -> [f64; 4] {
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    fn walk(c: &Value, xs: &mut Vec<f64>, ys: &mut Vec<f64>) {
        match c.as_array() {
            Some(a) if a.first().is_some_and(|v| v.is_number()) => {
                xs.push(a[0].as_f64().unwrap());
                ys.push(a[1].as_f64().unwrap_or(f64::NAN));
            }
            Some(a) => a.iter().for_each(|x| walk(x, xs, ys)),
            None => {}
        }
    }
    walk(&geom["coordinates"], &mut xs, &mut ys);
    let mn = |v: &[f64]| v.iter().cloned().fold(f64::INFINITY, f64::min);
    let mx = |v: &[f64]| v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    [mn(&xs), mn(&ys), mx(&xs), mx(&ys)]
}

fn overlaps(a: &[f64; 4], b: &[f64]) -> bool {
    !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3])
}

fn polygon_feature(api: &Api, pid: Option<&Value>, props: Value, cache: &RefCell<HashMap<String, Option<Value>>>) -> R<Option<Value>> {
    let Some(pid) = pid.filter(|p| truthy(Some(p))).map(py_str) else { return Ok(None) };
    if !cache.borrow().contains_key(&pid) {
        let res = api.get(&format!("serializedPolygons/{}", net::quote(&pid, "")), &[])?;
        let g = if truthy(res.get("kml")) { kml_to_geometry(&s_or_empty(res.get("kml"))) } else { None };
        cache.borrow_mut().insert(pid.clone(), g);
    }
    let Some(geom) = cache.borrow()[&pid].clone() else { return Ok(None) };
    let mut p = props.as_object().cloned().unwrap_or_default();
    p.insert("polygonId".into(), json!(pid));
    Ok(Some(obj! {"type" => "Feature", "geometry" => geom, "properties" => Value::Object(p)}))
}

pub fn run(config_path: &str, data_dir: &str, req: Option<Req>) -> R<String> {
    let key = std::env::var("FLOOD_FORECASTING_API_KEY").unwrap_or_default().trim().to_string();
    match req {
        Some(r) => run_with(config_path, data_dir, &key, r),
        None => {
            let real = real_req(key.clone());
            run_with(config_path, data_dir, &key, &real)
        }
    }
}

pub fn run_with(config_path: &str, data_dir: &str, key: &str, req: Req) -> R<String> {
    let cfg = read_json(config_path)?;
    let out = Path::new(data_dir);
    std::fs::create_dir_all(out).map_err(err)?;
    let region_code = cfg.get("floodhub_region").filter(|v| truthy(Some(v))).cloned();
    let mut region = cfg.get("floodhub_bbox_lonlat").filter(|v| truthy(Some(v))).cloned();
    if region_code.is_none() && region.is_none() {
        region = cfg.get("bbox_lonlat").cloned();
    }
    let mut summary = obj! {"configured" => false, "fetched" => now_iso(), "regionCode" => region_code.clone().unwrap_or(Value::Null),
        "region" => region.clone().unwrap_or(Value::Null), "attribution" => ATTRIBUTION};
    if key.is_empty() {
        summary["message"] = json!("Google Flood Hub is not connected yet.");
        write_json_indent(out.join("floodhub.json"), &summary, 2)?;
        return Ok("No FLOOD_FORECASTING_API_KEY; wrote a 'not connected' file.".into());
    }
    let api = Api { req, calls: Cell::new(0) };
    summary["configured"] = json!(true);
    let region_v: Vec<f64> = arr(region.as_ref()).iter().filter_map(|v| v.as_f64()).collect();
    let area = match &region_code {
        Some(c) => json!({"regionCode": c}),
        None => json!({"loop": region_loop(&region_v)}),
    };
    let mut features = Vec::new();
    let polys = RefCell::new(HashMap::new());
    let errors = RefCell::new(Vec::<String>::new());
    let mut log = Vec::new();
    let attempt = |label: &str, r: R<Value>, default: Value, log: &mut Vec<String>| -> Value {
        match r {
            Ok(v) => v,
            Err(e) => {
                errors.borrow_mut().push(format!("{}: {}", label, e));
                log.push(format!("warning: {}: {}", label, e));
                default
            }
        }
    };
    let with = |extra: Value| -> Value {
        let mut b = area.as_object().cloned().unwrap();
        b.extend(extra.as_object().cloned().unwrap());
        Value::Object(b)
    };
    let gauges = attempt("gauges", api.paged("gauges:searchGaugesByArea", &with(json!({"includeNonQualityVerified": true, "includeGaugesWithoutHydroModel": false})), "gauges").map(Value::from), json!([]), &mut log);
    let statuses = attempt("flood status", api.paged("floodStatus:searchLatestFloodStatusByArea", &with(json!({"includeNonQualityVerified": true})), "floodStatuses").map(Value::from), json!([]), &mut log);
    let mut by_id: Map<String, Value> = Map::new();
    for g in arr(Some(&gauges)) {
        by_id.insert(py_str(&g["gaugeId"]), g.clone());
    }
    for st in arr(Some(&statuses)) {
        let gid = py_str(&st["gaugeId"]);
        by_id.entry(gid.clone()).or_insert_with(|| obj! {"gaugeId" => st["gaugeId"].clone(), "location" => st.get("gaugeLocation").cloned().unwrap_or(Value::Null)});
        by_id[&gid]["status"] = st.clone();
    }
    let severity = |g: &Value| g.get("status").and_then(|s| s.get("severity")).and_then(|s| s.as_str()).map(String::from);
    let modelled: Vec<String> = by_id.iter().filter(|(_, g)| truthy(g.get("hasModel")) || truthy(g.get("status"))).map(|(k, _)| k.clone()).collect();
    let flagged: Vec<String> = modelled.iter().filter(|gid| severity(&by_id[gid.as_str()]).is_some_and(|s| ACTIVE.contains(&s.as_str()))).cloned().collect();
    for gid in if region_code.is_some() { &flagged } else { &modelled } {
        let m = attempt(&format!("model {}", gid), api.get(&format!("gaugeModels/{}", gid), &[]), Value::Null, &mut log);
        if truthy(Some(&m)) {
            let mut sel = Map::new();
            for k in ["gaugeModelId", "thresholds", "gaugeValueUnit", "qualityVerified"] {
                sel.insert(k.into(), m.get(k).cloned().unwrap_or(Value::Null));
            }
            by_id[gid.as_str()]["model"] = Value::Object(sel);
        }
    }
    if !modelled.is_empty() {
        let (y, mo, d) = civil_from_days(((now_s() - 2.0 * 86400.0) / 86400.0).floor() as i64);
        let start = format!("{:04}-{:02}-{:02}", y, mo, d);
        let mut params: Vec<(String, String)> = modelled.iter().take(500).map(|g| ("gaugeIds".to_string(), g.clone())).collect();
        params.push(("issuedTimeStart".into(), start));
        let fc = attempt("forecasts", api.get("gauges:queryGaugeForecasts", &params), json!({}), &mut log);
        if let Some(fcs) = fc.get("forecasts").and_then(|f| f.as_object()) {
            for (gid, fs) in fcs {
                let mut items: Vec<Value> = arr(fs.get("forecasts")).to_vec();
                items.sort_by_key(|f| s_or_empty(f.get("issuedTime")));
                if let (Some(latest), true) = (items.last(), by_id.contains_key(gid)) {
                    let values: Vec<Value> = arr(latest.get("forecastRanges")).iter().map(|r| json!([r.get("forecastStartTime").cloned().unwrap_or(Value::Null), r.get("value").cloned().unwrap_or(Value::Null)])).collect();
                    by_id[gid.as_str()]["forecast"] = obj! {"issuedTime" => latest.get("issuedTime").cloned().unwrap_or(Value::Null), "values" => values};
                }
            }
        }
    }
    // forecast flood areas from gauges that have them
    let ids: Vec<String> = by_id.keys().cloned().collect();
    for gid in ids {
        if region_code.is_some() && !flagged.contains(&gid) {
            continue;
        }
        let st = by_id[&gid].get("status").cloned().unwrap_or(json!({}));
        let ims = st.get("inundationMapSet").cloned().unwrap_or(json!({}));
        for im in arr(ims.get("inundationMaps")) {
            let props = obj! {"kind" => "forecast-area", "gaugeId" => gid.clone(), "level" => im.get("level").cloned().unwrap_or(Value::Null),
                "mapType" => ims.get("inundationMapType").cloned().unwrap_or(Value::Null), "severity" => st.get("severity").cloned().unwrap_or(Value::Null)};
            let f = attempt(&format!("area {}", gid), polygon_feature(&api, im.get("serializedPolygonId"), props, &polys).map(|f| f.unwrap_or(Value::Null)), Value::Null, &mut log);
            if !f.is_null() {
                features.push(f);
            }
        }
    }
    // flash floods in Australia that touch the region
    let flash = attempt("flash floods", api.paged("flashFloods:search", &json!({"countryCodes": ["AU"]}), "flashFloodEvents").map(Value::from), json!([]), &mut log);
    let mut kept: Vec<usize> = Vec::new();
    let flash = arr(Some(&flash)).to_vec();
    for (i, ev) in flash.iter().enumerate() {
        for (level, pid) in [("LIKELY", ev.get("likelyAffectedPolygonId")), ("HIGHLY_LIKELY", ev.get("highlyLikelyAffectedPolygonId"))] {
            let props = obj! {"kind" => "flash-flood", "level" => level, "issued" => ev.get("forecastIssueTime").cloned().unwrap_or(Value::Null),
                "hours" => ev.get("forecastPeriodHours").cloned().unwrap_or(Value::Null)};
            let f = attempt("flash flood area", polygon_feature(&api, pid, props, &polys).map(|f| f.unwrap_or(Value::Null)), Value::Null, &mut log);
            if !f.is_null() && (region.is_none() || overlaps(&geometry_bbox(&f["geometry"]), &region_v)) {
                features.push(f);
                kept.push(i);
            }
        }
    }
    let mut seen = Vec::new();
    let kept_events: Vec<Value> = kept.into_iter().filter(|i| if seen.contains(i) { false } else { seen.push(*i); true }).map(|i| flash[i].clone()).collect();
    let n_gauges = by_id.len();
    let flooding = by_id.values().filter(|g| severity(g).is_some_and(|s| ACTIVE.contains(&s.as_str()))).count();
    let errs = errors.borrow().clone();
    summary["gauges"] = Value::Array(by_id.into_iter().map(|(_, v)| v).collect());
    summary["flashFloodEvents"] = Value::from(kept_events.clone());
    summary["areas"] = json!(features.len());
    summary["apiCalls"] = json!(api.calls.get());
    summary["errors"] = json!(errs);
    write_json_indent(out.join("floodhub.json"), &summary, 1)?;
    write_json(out.join("floodhub.geojson"), &obj! {"type" => "FeatureCollection", "features" => features.clone()})?;
    log.push(format!(
        "Flood Hub: {} gauges, {} above normal, {} flash-flood events, {} areas, {} API calls, {} errors",
        n_gauges, flooding, kept_events.len(), features.len(), api.calls.get(), errs.len()
    ));
    Ok(log.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KML: &str = r#"<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
<Polygon><outerBoundaryIs><LinearRing><coordinates>
153.0,-27.5,0 153.1,-27.5,0 153.1,-27.4,0 153.0,-27.4,0 153.0,-27.5,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>"#;

    fn config() -> String {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../config/brisbane.json").to_string()
    }

    fn fake(_m: &str, path: &str, _p: &[(String, String)], body: Option<&Value>) -> R<Value> {
        Ok(match path {
            "gauges:searchGaugesByArea" => json!({"gauges": [
                {"gaugeId": "g1", "siteName": "Brisbane", "river": "Brisbane River", "hasModel": true, "location": {"latitude": -27.47, "longitude": 153.03}, "qualityVerified": true},
                {"gaugeId": "g2", "siteName": "No model", "hasModel": false, "location": {"latitude": -27.6, "longitude": 152.9}}]}),
            "floodStatus:searchLatestFloodStatusByArea" => {
                let b = body.unwrap();
                assert!(b.get("regionCode") == Some(&json!("AU")) || b["loop"]["vertices"].as_array().unwrap().len() == 4);
                json!({"floodStatuses": [{"gaugeId": "g1", "severity": "SEVERE", "forecastTrend": "RISE", "issuedTime": "2026-10-14T00:00:00Z",
                    "inundationMapSet": {"inundationMapType": "PROBABILITY", "inundationMaps": [{"level": "HIGH", "serializedPolygonId": "p1"}]}}]})
            }
            "gaugeModels/g1" => json!({"gaugeModelId": "m1", "gaugeValueUnit": "CUBIC_METERS_PER_SECOND", "thresholds": {"warningLevel": 100, "dangerLevel": 200}}),
            "gauges:queryGaugeForecasts" => json!({"forecasts": {"g1": {"forecasts": [
                {"issuedTime": "2026-10-13T00:00:00Z", "forecastRanges": [{"forecastStartTime": "a", "value": 1}]},
                {"issuedTime": "2026-10-14T00:00:00Z", "forecastRanges": [{"forecastStartTime": "2026-10-14T00:00:00Z", "value": 150}, {"forecastStartTime": "2026-10-15T00:00:00Z", "value": 220}]}]}}}),
            "flashFloods:search" => json!({"flashFloodEvents": [
                {"likelyAffectedPolygonId": "p2", "forecastIssueTime": "2026-10-14T01:00:00Z", "forecastPeriodHours": 6},
                {"likelyAffectedPolygonId": "far", "forecastIssueTime": "2026-10-14T01:00:00Z"}]}),
            p if p.starts_with("serializedPolygons/") => {
                let pid = &p["serializedPolygons/".len()..];
                let kml = if pid == "far" { KML.replace("153.0,", "130.0,").replace("153.1,", "130.1,") } else { KML.to_string() };
                json!({"polygonId": pid, "kml": kml})
            }
            p => panic!("unexpected call {}", p),
        })
    }

    #[test]
    fn kml_polygon_and_loop() {
        let g = kml_to_geometry(KML).unwrap();
        assert_eq!(g["type"], "Polygon");
        assert_eq!(g["coordinates"][0][0], json!([153.0, -27.5]));
        let v = region_loop(&[1.0, 2.0, 3.0, 4.0])["vertices"].as_array().unwrap().clone();
        let area: f64 = (0..4).map(|i| v[i]["longitude"].as_f64().unwrap() * v[(i + 1) % 4]["latitude"].as_f64().unwrap() - v[(i + 1) % 4]["longitude"].as_f64().unwrap() * v[i]["latitude"].as_f64().unwrap()).sum();
        assert!(area > 0.0);
    }

    #[test]
    fn without_key_writes_not_connected() {
        let d = std::env::temp_dir().join(format!("fh0-{}", std::process::id()));
        run_with(&config(), d.to_str().unwrap(), "", &fake).unwrap();
        assert_eq!(read_json(d.join("floodhub.json")).unwrap()["configured"], false);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn national_fetch_keeps_all_australian_flash_floods() {
        let d = std::env::temp_dir().join(format!("fh1-{}", std::process::id()));
        run_with(&config(), d.to_str().unwrap(), "test", &fake).unwrap();
        let s = read_json(d.join("floodhub.json")).unwrap();
        assert_eq!(s["regionCode"], "AU");
        assert_eq!(s["flashFloodEvents"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn full_fetch_with_a_box() {
        let d = std::env::temp_dir().join(format!("fh2-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let mut cfg = read_json(config()).unwrap();
        cfg.as_object_mut().unwrap().remove("floodhub_region");
        cfg["floodhub_bbox_lonlat"] = json!([151.9, -28.4, 153.6, -26.4]);
        let cp = d.join("cfg.json");
        std::fs::write(&cp, cfg.to_string()).unwrap();
        run_with(cp.to_str().unwrap(), d.to_str().unwrap(), "test", &fake).unwrap();
        let s = read_json(d.join("floodhub.json")).unwrap();
        let gj = read_json(d.join("floodhub.geojson")).unwrap();
        assert_eq!(s["configured"], true);
        assert_eq!(s["errors"], json!([]));
        let g1 = s["gauges"].as_array().unwrap().iter().find(|g| g["gaugeId"] == "g1").unwrap().clone();
        assert_eq!(g1["status"]["severity"], "SEVERE");
        assert_eq!(g1["model"]["thresholds"]["dangerLevel"], 200);
        assert_eq!(g1["forecast"]["values"][1][1], 220);
        let mut kinds: Vec<&str> = gj["features"].as_array().unwrap().iter().map(|f| f["properties"]["kind"].as_str().unwrap()).collect();
        kinds.sort();
        assert_eq!(kinds, ["flash-flood", "forecast-area"], "far-away flash flood dropped");
        assert_eq!(s["flashFloodEvents"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(d);
    }
}
