//! A rolling record of every gauge's level: one value per hour for the last
//! 7 days, built from the readings each refresh fetches (so it covers the
//! Bureau-only gauges too, which come with no series of their own). Kept in
//! S3 next to readings.json (readings-history.json.gz, about a megabyte) and
//! served one gauge at a time (/v1/history?site=).

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

pub const KEEP_HOURS: i64 = 7 * 24;

#[derive(Default, Clone)]
pub struct History {
    /// station -> (hour since 1970, level), oldest first
    pub sites: BTreeMap<String, Vec<(i64, f32)>>,
}

fn hour_of(iso: &str) -> Option<i64> {
    flood_feeds::ts_epoch(iso).map(|s| s.div_euclid(3600))
}

impl History {
    pub fn from_json(v: &Value) -> History {
        let mut h = History::default();
        if let Some(o) = v["sites"].as_object() {
            for (st, pts) in o {
                let p: Vec<(i64, f32)> = pts.as_array().map(|a| a.iter().filter_map(|x| Some((x[0].as_i64()?, x[1].as_f64()? as f32))).collect()).unwrap_or_default();
                if !p.is_empty() {
                    h.sites.insert(st.clone(), p);
                }
            }
        }
        h
    }

    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        for (st, p) in &self.sites {
            o.insert(st.clone(), Value::Array(p.iter().map(|(t, v)| json!([t, (*v as f64 * 1000.0).round() / 1000.0])).collect()));
        }
        json!({"v": 1, "step": "hour", "sites": o})
    }

    fn put(&mut self, st: &str, hour: i64, v: f64) -> bool {
        if !v.is_finite() {
            return false;
        }
        let p = self.sites.entry(st.to_string()).or_default();
        match p.binary_search_by_key(&hour, |x| x.0) {
            Ok(i) => {
                p[i].1 = v as f32; // a later reading in the same hour wins
                false
            }
            Err(i) => {
                p.insert(i, (hour, v as f32));
                true
            }
        }
    }

    /// Adds each gauge's latest level (and a live gauge's recent hourly
    /// series) from readings.json's "level"; drops what's older than a week.
    /// Returns how many new hours were added.
    pub fn add(&mut self, level: &Value, now_ms: i64) -> usize {
        let mut n = 0;
        let oldest = now_ms.div_euclid(3_600_000) - KEEP_HOURS;
        if let Some(o) = level.as_object() {
            for (st, r) in o {
                if let (Some(t), Some(v)) = (r["latest"][0].as_str().and_then(hour_of), r["latest"][1].as_f64()) {
                    if t >= oldest && self.put(st, t, v) {
                        n += 1;
                    }
                }
                // hourly series (Queensland's live gauges, hourly Water Data Online)
                if matches!(r["latestKind"].as_str(), Some("realtime") | Some("hourly")) {
                    for x in r["series"].as_array().into_iter().flatten() {
                        if let (Some(t), Some(v)) = (x[0].as_str().and_then(hour_of), x[1].as_f64()) {
                            if t >= oldest && self.put(st, t, v) {
                                n += 1;
                            }
                        }
                    }
                }
            }
        }
        self.prune(now_ms);
        n
    }

    pub fn prune(&mut self, now_ms: i64) {
        let oldest = now_ms.div_euclid(3_600_000) - KEEP_HOURS;
        for p in self.sites.values_mut() {
            p.retain(|x| x.0 >= oldest);
        }
        self.sites.retain(|_, p| !p.is_empty());
    }

    /// One gauge's record: [[ISO time, level], ...], oldest first.
    pub fn site(&self, st: &str) -> Option<Value> {
        let p = self.sites.get(st)?;
        Some(Value::Array(p.iter().map(|(t, v)| json!([crate::wmip::iso_utc(t * 3_600_000), (*v as f64 * 1000.0).round() / 1000.0])).collect()))
    }
}

pub fn gzip(b: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(b.len() / 5), flate2::Compression::new(6));
    enc.write_all(b).and_then(|_| enc.finish()).unwrap_or_default()
}

pub fn gunzip(b: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut out = Vec::with_capacity(b.len() * 6);
    flate2::read::GzDecoder::new(b).read_to_end(&mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3_600_000;

    #[test]
    fn keeps_one_value_an_hour_for_a_week() {
        let now = 1_792_540_800_000; // 2026-10-21T00:00:00Z
        let mut h = History::default();
        let lv = |iso: &str, v: f64| json!({"A": {"latest": [iso, v], "latestKind": "bureau", "series": []}});
        assert_eq!(h.add(&lv("2026-10-20T23:10:00+00:00", 1.0), now), 1);
        assert_eq!(h.add(&lv("2026-10-20T23:50:00+00:00", 1.2), now), 0, "same hour: replaced");
        assert_eq!(h.add(&lv("2026-10-21T10:05:00+10:00", 1.3), now + H), 1);
        assert_eq!(h.sites["A"], vec![(now / H - 1, 1.2), (now / H, 1.3)]);
        // a week on, the first hour drops out
        h.add(&lv("2026-10-27T23:30:00+00:00", 2.0), now + KEEP_HOURS * H);
        assert_eq!(h.sites["A"].first().unwrap().0, now / H);
        let back = History::from_json(&h.to_json());
        assert_eq!(back.sites["A"].len(), h.sites["A"].len());
        assert_eq!(h.site("A").unwrap()[0][0], "2026-10-21T00:00:00Z");
        assert!(h.site("B").is_none());
    }

    #[test]
    fn a_live_gauges_hourly_series_fills_the_hours() {
        let now = 1_792_540_800_000;
        let mut h = History::default();
        let lv = json!({"Q": {"latest": ["2026-10-21T10:00:00+10:00", 3.0], "latestKind": "realtime",
            "series": [["2026-10-21T07:00:00+10:00", 2.7], ["2026-10-21T08:00:00+10:00", 2.8], ["2026-10-21T09:00:00+10:00", 2.9]]},
            "D": {"latest": ["2026-10-19", 5.0], "latestKind": "daily", "series": [["2026-10-18", 4.0]]}});
        assert_eq!(h.add(&lv, now), 4, "the daily gauge's date has no time and is skipped");
        assert!(!h.sites.contains_key("D"));
        let z = gzip(&serde_json::to_vec(&h.to_json()).unwrap());
        assert_eq!(History::from_json(&serde_json::from_slice(&gunzip(&z).unwrap()).unwrap()).sites["Q"].len(), 4);
    }
}
