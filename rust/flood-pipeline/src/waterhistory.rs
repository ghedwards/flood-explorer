//! Satellite water history for every BoM water storage (DEA Waterbodies;
//! was pipeline/fetch_waterhistory.py).
//!
//! Usage: flood waterhistory <national_dir> [previous.json]
//!
//! Within a time budget (WATERHISTORY_BUDGET_S, default 300 s), three dams
//! at a time: the waterbody polygon at the dam, its Landsat time series,
//! as monthly mean % wet. Dams fetched in the last week are kept. Writes
//! waterhistory.json {storage id: {start, monthly, last, passes, uid,
//! area_m2, fetched} or {missing, fetched}}.

use crate::net::{self, NetErr};
use crate::util::*;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

const WFS: &str = "https://geoserver.dea.ga.gov.au/geoserver/wfs";
const LAYER: &str = "DigitalEarthAustraliaWaterbodies_v3";

/// A fetch: Ok(text), or Err(None) for a file that doesn't exist, or
/// Err(Some(message)).
pub type Get<'a> = &'a (dyn Fn(&str) -> Result<String, Option<String>> + Sync);

pub fn get(url: &str) -> Result<String, Option<String>> {
    let mut last = String::new();
    for attempt in 0..2 {
        match net::get(url, &[], 30) {
            Ok(r) => return Ok(r.text()),
            // DEA's store answers 403 for files that don't exist
            Err(NetErr::Status(403 | 404, _)) => return Err(None),
            Err(e) => last = e.to_string(),
        }
        if attempt == 0 {
            std::thread::sleep(std::time::Duration::from_secs(3));
        }
    }
    Err(Some(format!("{}: {}", clip(url, 100), last)))
}

fn get_json(g: Get, url: &str) -> Result<Value, Option<String>> {
    let t = g(url)?;
    serde_json::from_str(&t).map_err(|e| Some(e.to_string()))
}

pub fn point_in_ring(x: f64, y: f64, ring: &[Value]) -> bool {
    let pt = |v: &Value| (v[0].as_f64().unwrap_or(f64::NAN), v[1].as_f64().unwrap_or(f64::NAN));
    let mut inside = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let ((xi, yi), (xj, yj)) = (pt(&ring[i]), pt(&ring[j]));
        let dy = if yj - yi == 0.0 { 1e-12 } else { yj - yi };
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / dy + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn contains(geom: &Value, x: f64, y: f64) -> bool {
    let polys: Vec<&Value> = if get_str(geom, "type") == Some("Polygon") { vec![&geom["coordinates"]] } else { arr(geom.get("coordinates")).iter().collect() };
    polys.iter().any(|p| {
        let rings = arr(Some(p));
        !rings.is_empty() && point_in_ring(x, y, arr(Some(&rings[0]))) && !rings[1..].iter().any(|h| point_in_ring(x, y, arr(Some(h))))
    })
}

fn find_waterbody(g: Get, lon: f64, lat: f64) -> Result<Option<Value>, Option<String>> {
    let d = 0.03;
    let bbox = format!("{},{},{},{},EPSG:4326", py_float(lon - d), py_float(lat - d), py_float(lon + d), py_float(lat + d));
    let q = net::urlencode(&[("service", "WFS"), ("version", "1.1.0"), ("request", "GetFeature"), ("typeName", LAYER), ("outputFormat", "application/json"), ("srsName", "EPSG:4326"), ("bbox", bbox.as_str())]);
    let res = get_json(g, &format!("{}?{}", WFS, q))?;
    let feats: Vec<Value> = arr(res.get("features")).iter().filter(|f| truthy(f.get("geometry"))).cloned().collect();
    if feats.is_empty() {
        return Ok(None);
    }
    let inside: Vec<&Value> = feats.iter().filter(|f| contains(&f["geometry"], lon, lat)).collect();
    let pool: Vec<&Value> = if inside.is_empty() { feats.iter().collect() } else { inside };
    let area = |f: &Value| f["properties"].get("area_m2").and_then(|a| a.as_f64()).unwrap_or(0.0);
    let mut best = pool[0];
    for f in &pool {
        if area(f) > area(best) {
            best = f;
        }
    }
    Ok(Some(best.clone()))
}

pub fn monthly_series(text: &str) -> Option<Map<String, Value>> {
    let rows = csv_rows(text);
    let mut by_month: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let (mut last, mut passes) = (Value::Null, 0);
    for r in rows.iter().skip(1) {
        if r.len() < 2 || r[1].trim().is_empty() {
            continue;
        }
        let Ok(pc) = r[1].trim().parse::<f64>() else { continue };
        let date = clip(&r[0], 10);
        passes += 1;
        by_month.entry(clip(&date, 7)).or_default().push(pc);
        last = json!([date, num(round_to(pc, 1))]);
    }
    let first = by_month.keys().next()?.clone();
    let lastm = by_month.keys().last()?.clone();
    let ym = |s: &str| -> Option<(i64, i64)> { Some((s.get(..4)?.parse().ok()?, s.get(5..7)?.parse().ok()?)) };
    let ((mut y, mut m), (ey, em)) = (ym(&first)?, ym(&lastm)?);
    let mut out = Vec::new();
    while (y, m) <= (ey, em) {
        out.push(match by_month.get(&format!("{:04}-{:02}", y, m)) {
            Some(v) => json!(round_even(v.iter().sum::<f64>() / v.len() as f64) as i64),
            None => Value::Null,
        });
        m += 1;
        if m > 12 {
            y += 1;
            m = 1;
        }
    }
    let mut o = Map::new();
    o.insert("start".into(), json!(first));
    o.insert("monthly".into(), json!(out));
    o.insert("last".into(), last);
    o.insert("passes".into(), json!(passes));
    Some(o)
}

/// (storage id, series or None, why not)
type HistoryResult = (String, Option<Map<String, Value>>, Option<&'static str>);

fn one(g: Get, feature: &Value) -> Result<HistoryResult, String> {
    let id = py_str(&feature["properties"]["id"]);
    let c = &feature["geometry"]["coordinates"];
    let (lon, lat) = (c[0].as_f64().unwrap_or(f64::NAN), c[1].as_f64().unwrap_or(f64::NAN));
    let wb = match find_waterbody(g, lon, lat) {
        Ok(Some(w)) => w,
        Ok(None) => return Ok((id, None, Some("no waterbody"))),
        Err(e) => return Err(e.unwrap_or_else(|| "waterbody service: not found".into())),
    };
    let Some(url) = wb["properties"].get("timeseries").filter(|u| truthy(Some(u))).map(py_str).filter(|u| u.starts_with("https://") || u.starts_with("http://")) else {
        return Ok((id, None, Some("no time series")));
    };
    let text = match g(&url) {
        Ok(t) => t,
        Err(None) => return Ok((id, None, Some("no time series file"))),
        Err(Some(e)) => return Err(e),
    };
    let Some(mut series) = monthly_series(&text) else { return Ok((id, None, Some("empty time series"))) };
    series.insert("uid".into(), wb["properties"].get("uid").cloned().unwrap_or(Value::Null));
    series.insert("area_m2".into(), wb["properties"].get("area_m2").cloned().unwrap_or(Value::Null));
    Ok((id, Some(series), None))
}

fn days_between(a: &str, b: &str) -> Option<i64> {
    let d = |s: &str| -> Option<i64> { Some(days_from_civil(s.get(..4)?.parse().ok()?, s.get(5..7)?.parse().ok()?, s.get(8..10)?.parse().ok()?)) };
    Some(d(b)? - d(a)?)
}

pub fn run(national_dir: &str, previous: &str, g: Get) -> R<String> {
    let d = Path::new(national_dir);
    let storages = arr(read_json(d.join("storages.geojson"))?.get("features")).to_vec();
    let budget: f64 = std::env::var("WATERHISTORY_BUDGET_S").ok().and_then(|v| v.parse().ok()).unwrap_or(300.0);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs_f64(budget);
    let today = today();
    let mut out: Map<String, Value> = if !previous.is_empty() && Path::new(previous).exists() {
        read_json(previous).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default()
    } else {
        Map::new()
    };
    let fresh = |out: &Map<String, Value>, sid: &str| -> bool {
        match out.get(sid).and_then(|h| get_str(h, "fetched")) {
            Some(f) => days_between(f, &today).is_some_and(|n| n < 7),
            None => false,
        }
    };
    let sid = |f: &Value| py_str(&f["properties"]["id"]);
    let mut todo: Vec<&Value> = storages.iter().filter(|f| !fresh(&out, &sid(f))).collect();
    // dams never fetched first, then the stalest
    todo.sort_by_key(|f| {
        let id = sid(f);
        (out.contains_key(&id), out.get(&id).and_then(|h| get_str(h, "fetched")).unwrap_or("").to_string())
    });
    let queue = Arc::new(Mutex::new(todo.into_iter()));
    let results = Arc::new(Mutex::new(Vec::new()));
    std::thread::scope(|s| {
        for _ in 0..3 {
            let (queue, results) = (queue.clone(), results.clone());
            s.spawn(move || loop {
                if std::time::Instant::now() > deadline {
                    return;
                }
                let Some(f) = queue.lock().unwrap().next() else { return };
                let r = one(g, f);
                results.lock().unwrap().push(r);
            });
        }
    });
    let (mut done, mut misses, mut errors) = (0, 0, Vec::new());
    for r in Arc::try_unwrap(results).unwrap().into_inner().unwrap() {
        match r {
            Ok((id, Some(mut series), _)) => {
                series.insert("fetched".into(), json!(today));
                out.insert(id, Value::Object(series));
                done += 1;
            }
            Ok((id, None, why)) => {
                misses += 1;
                let had_missing = out.get(&id).is_none_or(|h| truthy(h.get("missing")));
                if had_missing {
                    // remember the miss so it isn't retried for a week
                    out.insert(id, json!({"missing": why.unwrap_or(""), "fetched": today}));
                }
            }
            Err(e) => errors.push(clip(&e, 200)),
        }
    }
    write_json(d.join("waterhistory.json"), &Value::Object(out.clone()))?;
    let left = storages.iter().filter(|f| !fresh(&out, &sid(f))).count();
    let have = out.values().filter(|h| !truthy(h.get("missing"))).count();
    let mut msg = format!(
        "Water history: {} of {} dams on record ({} updated this run, {} without a record, {} errors, {} still to fetch)",
        have, storages.len(), done, misses, errors.len(), left
    );
    for e in errors.iter().take(3) {
        msg.push_str(&format!("\nwarning: {}", e));
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSV: &str = "date,pc_wet,px_wet\n1987-06-03T00:00:00Z,50.0,100\n1987-06-19T00:00:00Z,60.0,120\n1987-08-01T00:00:00Z,,\n1987-08-21T00:00:00Z,70.5,140\n";

    fn fake(url: &str) -> Result<String, Option<String>> {
        if url.starts_with(WFS) {
            assert!(url.contains("bbox="));
            let ring = json!([[152.5, -27.3], [152.6, -27.3], [152.6, -27.2], [152.5, -27.2], [152.5, -27.3]]);
            let far = json!([[150.0, -27.3], [150.1, -27.3], [150.1, -27.2], [150.0, -27.2], [150.0, -27.3]]);
            return Ok(json!({"features": [
                {"geometry": {"type": "Polygon", "coordinates": [far]}, "properties": {"uid": "big", "area_m2": 9e9, "timeseries": "x"}},
                {"geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": {"uid": "r7hk", "area_m2": 1e8, "timeseries": "https://ts/r7hk.csv"}},
            ]}).to_string());
        }
        if url == "https://ts/r7hk.csv" {
            return Ok(CSV.into());
        }
        panic!("{}", url)
    }

    fn dir(tag: &str, ids: &[&str]) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("wh-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let feats: Vec<Value> = ids.iter().map(|i| json!({"geometry": {"type": "Point", "coordinates": [152.55, -27.25]}, "properties": {"id": i}})).collect();
        std::fs::write(d.join("storages.geojson"), json!({"features": feats}).to_string()).unwrap();
        d
    }

    #[test]
    fn monthly() {
        let s = monthly_series(CSV).unwrap();
        assert_eq!(s["start"], "1987-06");
        assert_eq!(s["monthly"], json!([55, null, 70]), "July had no pass");
        assert_eq!(s["last"], json!(["1987-08-21", 70.5]));
        assert_eq!(s["passes"], 3);
    }

    #[test]
    fn picks_waterbody_containing_the_dam() {
        let d = dir("a", &["7"]);
        run(d.to_str().unwrap(), "", &fake).unwrap();
        let out = read_json(d.join("waterhistory.json")).unwrap();
        assert_eq!(out["7"]["uid"], "r7hk");
        assert!(out["7"].get("fetched").is_some());
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn keeps_fresh_records_and_fills_missing() {
        let d = dir("b", &["7", "8"]);
        let prev = d.join("prev.json");
        std::fs::write(&prev, json!({"7": {"uid": "kept", "fetched": today()}}).to_string()).unwrap();
        run(d.to_str().unwrap(), prev.to_str().unwrap(), &fake).unwrap();
        let out = read_json(d.join("waterhistory.json")).unwrap();
        assert_eq!(out["7"]["uid"], "kept", "fresh: not refetched");
        assert_eq!(out["8"]["uid"], "r7hk", "missing: fetched");
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    fn forbidden_file_is_recorded_as_missing() {
        let d = dir("c", &["9"]);
        let g = |url: &str| if url.starts_with(WFS) { fake(url) } else { Err(None) };
        run(d.to_str().unwrap(), "", &g).unwrap();
        let out = read_json(d.join("waterhistory.json")).unwrap();
        assert_eq!(out["9"]["missing"], "no time series file");
        let _ = std::fs::remove_dir_all(d);
    }
}
