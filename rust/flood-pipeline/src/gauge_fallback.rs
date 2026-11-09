//! A gauge list from the flood-class feed, for when the Bureau's gauge service cannot be reached.
//!
//! Usage: flood gauges-fallback <national_dir>
//!
//! `flood national` builds the gauge list from the Bureau's ArcGIS gauge service, which can refuse or time
//! out connections from the build machine; the build then publishes an empty list and the map shows no
//! gauges. `flood floodinfo` reads a different Bureau source (the river height pages) that does work from
//! there, and its floodclass.json holds, for every flood gauge, a name and a position. When meta.json says no
//! gauges were fetched and floodclass.json has some, this writes gauges.geojson, gauges.min.json,
//! gauges-core.min.json and an empty gauges-river.min.json from it, and says so in meta.json
//! (`gaugeSource`), keeping the fetch errors. Otherwise it changes nothing.
//!
//! The fallback gauges are plain "information" gauges with their Bureau station number, name and position:
//! no state, basin, agency or Water Data Online station number, and no dams or river-only gauges, because
//! the feed does not carry them.

use crate::national::compact;
use crate::util::*;
use serde_json::{json, Map, Value};
use std::path::Path;

pub const SOURCE: &str = "the Bureau's flood class feed (its gauge list service could not be reached)";

/// Gauge features from floodclass.json: one per entry with a name and a finite position, in station order.
pub fn features_from_floodclass(fc: &Map<String, Value>) -> Vec<Value> {
    let mut keys: Vec<&String> = fc.keys().collect();
    keys.sort();
    keys.into_iter().filter_map(|st| {
        let g = &fc[st];
        let name = g["name"].as_str().map(str::trim).filter(|n| !n.is_empty())?;
        let lat = g["lat"].as_f64().filter(|v| v.is_finite())?;
        let lon = g["lon"].as_f64().filter(|v| v.is_finite())?;
        Some(json!({
            "type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"id": st, "station": "", "bom": st, "name": name, "state": Value::Null, "basin": Value::Null,
                           "agency": Value::Null, "types": Value::Null, "kind": "information"},
        }))
    }).collect()
}

pub fn run(dir: &str) -> R<String> {
    let dir = Path::new(dir);
    let meta_path = dir.join("meta.json");
    let mut meta: Value = serde_json::from_slice(&std::fs::read(&meta_path).map_err(|e| format!("{}: {e}", meta_path.display()))?).map_err(|e| format!("meta.json: {e}"))?;
    let have = meta["gauges"].as_u64().unwrap_or(0);
    if have > 0 {
        return Ok(format!("Gauge fallback: not needed ({have} gauges from the gauge service)"));
    }
    let fc_path = dir.join("floodclass.json");
    let fc: Value = match std::fs::read(&fc_path) {
        Ok(b) => serde_json::from_slice(&b).map_err(|e| format!("floodclass.json: {e}"))?,
        Err(_) => return Ok("Gauge fallback: there is no floodclass.json to build a gauge list from".into()),
    };
    let feats = features_from_floodclass(fc.as_object().ok_or("floodclass.json is not an object")?);
    if feats.is_empty() {
        return Ok("Gauge fallback: floodclass.json has no gauges with a name and a position".into());
    }
    write_json(dir.join("gauges.geojson"), &json!({"type": "FeatureCollection", "features": feats}))?;
    write_json(dir.join("gauges.min.json"), &compact(&feats))?;
    write_json(dir.join("gauges-core.min.json"), &compact(&feats))?;
    write_json(dir.join("gauges-river.min.json"), &compact(&[]))?;
    meta["gauges"] = json!(feats.len());
    meta["gaugeKinds"] = json!({"information": feats.len()});
    meta["gaugeSource"] = json!(SOURCE);
    write_json_indent(dir.join("meta.json"), &meta, 1)?;
    Ok(format!("Gauge fallback: {} gauges from {SOURCE}; no dams or river-only gauges", feats.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fc() -> Value {
        json!({
            "559023": {"station": "559023", "name": "Orara River at Karangi", "lat": -30.2544, "lon": 153.0328, "level": 0.91, "class": "No Classification"},
            "41498": {"station": "41498", "name": " Condamine River at Cecil Plains ", "lat": -27.5333, "lon": 151.205, "level": 4.0},
            "1": {"station": "1", "name": "No position", "level": 1.0},
            "2": {"station": "2", "name": "", "lat": -27.0, "lon": 151.0},
            "3": {"station": "3", "name": "Not finite", "lat": null, "lon": 151.0},
        })
    }
    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("gauge-fallback-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_gauges_with_a_name_and_a_position_are_used_in_station_order() {
        let f = features_from_floodclass(fc().as_object().unwrap());
        let names: Vec<&str> = f.iter().map(|x| x["properties"]["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["Condamine River at Cecil Plains", "Orara River at Karangi"]);
        assert_eq!(f[1]["geometry"]["coordinates"], json!([153.0328, -30.2544]));
        assert_eq!(f[0]["properties"]["bom"], "41498");
        assert_eq!(f[0]["properties"]["kind"], "information");
    }

    #[test]
    fn an_empty_gauge_list_is_rebuilt_from_the_flood_class_file_and_meta_says_so() {
        let d = dir("empty");
        std::fs::write(d.join("meta.json"), r#"{"gauges":0,"gaugeKinds":{},"errors":["gauge layer 2: timeout: connect"]}"#).unwrap();
        std::fs::write(d.join("floodclass.json"), fc().to_string()).unwrap();
        let msg = run(d.to_str().unwrap()).unwrap();
        assert!(msg.contains("2 gauges"), "{msg}");
        let meta: Value = serde_json::from_slice(&std::fs::read(d.join("meta.json")).unwrap()).unwrap();
        assert_eq!((meta["gauges"].as_u64(), meta["gaugeKinds"]["information"].as_u64()), (Some(2), Some(2)));
        assert_eq!(meta["gaugeSource"], SOURCE);
        assert_eq!(meta["errors"], json!(["gauge layer 2: timeout: connect"]), "the fetch errors are kept");
        let core: Value = serde_json::from_slice(&std::fs::read(d.join("gauges-core.min.json")).unwrap()).unwrap();
        assert_eq!(core["rows"].as_array().unwrap().len(), 2);
        let river: Value = serde_json::from_slice(&std::fs::read(d.join("gauges-river.min.json")).unwrap()).unwrap();
        assert_eq!(river["rows"].as_array().unwrap().len(), 0);
        let geo: Value = serde_json::from_slice(&std::fs::read(d.join("gauges.geojson")).unwrap()).unwrap();
        assert_eq!(geo["features"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_gauge_list_from_the_gauge_service_is_left_alone() {
        let d = dir("have");
        std::fs::write(d.join("meta.json"), r#"{"gauges":3839}"#).unwrap();
        std::fs::write(d.join("floodclass.json"), fc().to_string()).unwrap();
        let msg = run(d.to_str().unwrap()).unwrap();
        assert!(msg.contains("not needed"), "{msg}");
        assert!(!d.join("gauges-core.min.json").exists(), "nothing was written");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn without_a_flood_class_file_nothing_is_written() {
        let d = dir("nofc");
        std::fs::write(d.join("meta.json"), r#"{"gauges":0}"#).unwrap();
        let msg = run(d.to_str().unwrap()).unwrap();
        assert!(msg.contains("no floodclass.json"), "{msg}");
        assert!(!d.join("gauges.geojson").exists());
        std::fs::remove_dir_all(&d).ok();
    }
}
