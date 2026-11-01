//! Recorded rainfall snapshots. Only explicitly named hourly sums in mm qualify;
//! cumulative/as-stored and daily rainfall must not be guessed into hourly rain.
use crate::events::Kiwis;
use crate::national::{col, kp};
use crate::util::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SOURCE: &str = "Bureau of Meteorology Water Data Online; rainfall data supplied by station custodians";
fn number(v: &Value) -> Option<f64> { v.as_f64().or_else(|| v.as_str()?.parse().ok()) }
fn text(v: &Value) -> String { v.as_str().map(str::to_owned).unwrap_or_else(|| v.to_string()) }

/// Values timestamped at the END of an hour become that hour's rate in mm/h.
/// Missing, negative, non-hourly and conflicting records remain missing, not zero.
pub fn hourly(points: &[Value], start: f64, hours: usize) -> Vec<Option<f64>> {
    let mut bins: BTreeMap<usize, Vec<Option<f64>>> = BTreeMap::new();
    for point in points {
        let Some(time) = point[0].as_str().and_then(|s| parse_iso(s, 10)) else { continue };
        let hour = (time - start) / 3600.0 - 1.0;
        if !hour.is_finite() || hour < 0.0 || hour >= hours as f64 || (hour - hour.round()).abs() > 1e-6 { continue; }
        let value = number(&point[1]).filter(|v| v.is_finite() && (0.0..=1000.0).contains(v));
        bins.entry(hour.round() as usize).or_default().push(value);
    }
    (0..hours).map(|i| {
        let values = bins.get(&i)?;
        let first = values.first().copied().flatten()?;
        values.iter().all(|v| *v == Some(first)).then_some(first)
    }).collect()
}

fn stations(kiwis: Kiwis, lat: f64, lon: f64, radius: f64) -> R<Vec<Value>> {
    let dy = radius / 110.574;
    let dx = radius / (111.32 * lat.to_radians().cos());
    let bbox = format!("{},{},{},{}", lon-dx, lat-dy, lon+dx, lat+dy);
    let table = kiwis(&kp(&[("request", "getStationList"), ("bBox", &bbox),
        ("returnfields", "station_no,station_name,station_latitude,station_longitude")]))?;
    let rows = table.as_array().ok_or("Expected a rainfall station table")?;
    let header = rows.first().ok_or("Missing rainfall station header")?;
    let id = col(header, "station_no").ok_or("Missing station_no")?;
    let name = col(header, "station_name").ok_or("Missing station_name")?;
    let y = col(header, "station_latitude").ok_or("Missing latitude")?;
    let x = col(header, "station_longitude").ok_or("Missing longitude")?;
    let mut candidates = Vec::new();
    for row in &rows[1..] {
        let (Some(y), Some(x)) = (number(&row[y]), number(&row[x])) else { continue };
        let distance = km(lat, lon, y, x);
        if distance.is_finite() && distance <= radius {
            candidates.push((distance, json!({"id":text(&row[id]), "name":text(&row[name]), "lat":y, "lon":x})));
        }
    }
    candidates.sort_by(|a,b| a.0.total_cmp(&b.0));
    Ok(candidates.into_iter().take(12).map(|(_, station)| station).collect())
}

fn station_rain(kiwis: Kiwis, mut station: Value, start: f64, end: f64) -> R<Option<Value>> {
    let table = kiwis(&kp(&[("request", "getTimeseriesList"), ("station_no", station["id"].as_str().unwrap()),
        ("parametertype_name", "Rainfall"), ("returnfields", "ts_id,ts_name,ts_unitsymbol")]))?;
    let rows = table.as_array().ok_or("Expected rainfall timeseries table")?;
    let Some(header) = rows.first() else { return Ok(None) };
    let (Some(id), Some(name), Some(unit)) = (col(header,"ts_id"),col(header,"ts_name"),col(header,"ts_unitsymbol")) else { return Ok(None) };
    let mut candidates: Vec<_> = rows[1..].iter().filter(|row| {
        text(&row[name]).contains("HourlySum") && row[unit].as_str() == Some("mm")
    }).collect();
    candidates.sort_by_key(|row| (!text(&row[name]).contains("Merged"), text(&row[id])));
    for row in candidates.into_iter().take(2) {
        let ts_id = text(&row[id]);
        let response = kiwis(&kp(&[("request", "getTimeseriesValues"), ("ts_id", &ts_id),
            ("from", &iso(start, 0)), ("to", &iso(end, 0)), ("returnfields", "Timestamp,Value")]))?;
        let points = response.as_array().and_then(|r| r.first()).and_then(|r| r["data"].as_array());
        let Some(points) = points else { continue };
        let rain = hourly(points, start, ((end-start)/3600.0) as usize);
        if !rain.windows(2).any(|w| w.iter().all(Option::is_some)) { continue; }
        station["tsId"] = json!(ts_id);
        station["tsName"] = row[name].clone();
        station["unit"] = json!("mm");
        station["intervalSeconds"] = json!(3600);
        station["timestampConvention"] = json!("interval-end");
        station["rainMm"] = json!(rain);
        return Ok(Some(station));
    }
    Ok(None)
}

pub fn collect(config: &Value, kiwis: Kiwis) -> R<Value> {
    let events = config["events"].as_array().ok_or("Expected events array")?;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    for event in events {
        let result = (|| -> R<Value> {
            let lat = number(&event["lat"]).filter(|v| v.is_finite() && v.abs() < 85.0).ok_or("Invalid event latitude")?;
            let lon = number(&event["lon"]).filter(|v| v.is_finite() && v.abs() <= 180.0).ok_or("Invalid event longitude")?;
            // Existing event dates are documented in fixed AEST, consistent with flood events.
            let start = event["start"].as_str().and_then(|s| parse_iso(s,10)).ok_or("Invalid storm start")?;
            let end = event["end"].as_str().and_then(|s| parse_iso(s,10)).ok_or("Invalid storm end")?;
            if !(3600.0..=32.0*86400.0).contains(&(end-start)) { return Err("Storm window must be 1 hour to 32 days".into()); }
            let radius = event["rainRadiusKm"].as_f64().unwrap_or(50.0).clamp(1.0,100.0);
            let mut gauges = Vec::new();
            for station in stations(kiwis, lat, lon, radius)? {
                match station_rain(kiwis, station, start, end) {
                    Ok(Some(rain)) => gauges.push(rain),
                    Ok(None) => {},
                    Err(error) => errors.push(format!("{}: {}", event["id"], error)),
                }
                if gauges.len() >= 3 { break; }
            }
            Ok(json!({"id":event["id"],"name":event["name"],"lat":lat,"lon":lon,
                "start":iso(start,0),"end":iso(end,0),"stations":gauges}))
        })();
        match result {
            Ok(value) => output.push(value),
            Err(error) => errors.push(format!("{}: {}",event["id"],error)),
        }
    }
    Ok(json!({"schemaVersion":1,"fetched":now_iso(),"source":SOURCE,"events":output,"errors":errors}))
}

pub fn run(config_path: &str, out_path: &str, kiwis: Kiwis) -> R<String> {
    let snapshot = collect(&read_json(config_path)?, kiwis)?;
    let count: usize = snapshot["events"].as_array().unwrap().iter().map(|e| e["stations"].as_array().unwrap().len()).sum();
    // Never replace a last-good snapshot with an outage or unsupported series.
    if count == 0 { return Err(format!("No usable hourly rainfall; previous snapshot retained. {}", snapshot["errors"])); }
    let path = std::path::Path::new(out_path);
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) { std::fs::create_dir_all(parent).map_err(err)?; }
    let temp = path.with_extension("tmp");
    write_json_indent(&temp, &snapshot, 2)?;
    std::fs::rename(temp, path).map_err(err)?;
    Ok(format!("Recorded storms: {count} station/event series; {} source errors",snapshot["errors"].as_array().unwrap().len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hourly_rain_is_interval_end_sum_not_a_mean_or_zero_filled_gap() {
        let start = parse_iso("2022-02-24T00:00:00+10:00",10).unwrap();
        let points = json!([["2022-02-24T00:00:00+10:00",99],["2022-02-23T15:00:00Z",3],
            ["2022-02-24T02:00:00+10:00",0],["2022-02-24T03:00:00+10:00",-999],
            ["2022-02-24T04:00:00+10:00",4],["2022-02-24T04:00:00+10:00",5],
            ["2022-02-24T05:30:00+10:00",7]]);
        assert_eq!(hourly(points.as_array().unwrap(),start,6), vec![Some(3.0),Some(0.0),None,None,None,None]);
    }
    #[test]
    fn only_hourly_mm_series_are_used_and_source_outages_remain_errors() {
        let cfg = json!({"events":[{"id":"test","name":"Test","lat":-27.0,"lon":153.0,"start":"2022-02-24","end":"2022-02-25"}]});
        let fake = |p: &[(String,String)]| -> R<Value> {
            let get = |key| p.iter().find(|(k,_)| k==key).map(|(_,v)|v.as_str()).unwrap_or("");
            match get("request") {
                "getStationList" => Ok(json!([["station_no","station_name","station_latitude","station_longitude"],["s1","Rain gauge",-27,153]])),
                "getTimeseriesList" => Ok(json!([["ts_id","ts_name","ts_unitsymbol"],["daily","DailySum","mm"],["raw","AsStored","mm"],["hour","Rain.Merged.HourlySum","mm"]])),
                "getTimeseriesValues" => { assert_eq!(get("ts_id"),"hour"); Ok(json!([{"data":[["2022-02-24T01:00:00+10:00",3],["2022-02-24T02:00:00+10:00",0]]}])) },
                _ => panic!("unexpected query"),
            }
        };
        let result = collect(&cfg,&fake).unwrap();
        assert_eq!(result["events"][0]["stations"][0]["rainMm"][0].as_f64(),Some(3.0));
        let outage = collect(&cfg,&|_|Err("DatasourceError".into())).unwrap();
        assert_eq!(outage["errors"].as_array().unwrap().len(),1);
        assert!(outage["events"].as_array().unwrap().is_empty());
    }
    #[test]
    fn an_outage_does_not_overwrite_a_last_good_snapshot() {
        let dir = std::env::temp_dir().join(format!("flood-rainfall-{}",std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("events.json");
        let out = dir.join("rain-storms.json");
        std::fs::write(&cfg,r#"{"events":[{"id":"test","lat":-27,"lon":153,"start":"2022-02-24","end":"2022-02-25"}]}"#).unwrap();
        std::fs::write(&out,"last good snapshot").unwrap();
        assert!(run(cfg.to_str().unwrap(),out.to_str().unwrap(),&|_|Err("DatasourceError".into())).is_err());
        assert_eq!(std::fs::read_to_string(&out).unwrap(),"last good snapshot");
        std::fs::remove_dir_all(dir).unwrap();
    }

}
