//! Readings for the whole map (readings.json), kept fresh by the broker
//! instead of the 3-hourly site build: river levels and dam volumes from
//! Water Data Online, with Queensland's live river levels, fetched by the
//! same code the build uses (flood-feeds).
//!
//! On a server it refreshes itself every few minutes and keeps the result in
//! memory. On Lambda a schedule invokes it to refresh and the result goes to
//! S3, so every running copy serves the same file.

use crate::s3::Bucket;
use flood_feeds as feeds;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

pub const STATIONS_URL: &str = "https://ghedwards.github.io/flood-explorer/data/national/stations.json";
const KEY: &str = "readings.json";
const S3_CHECK_MS: i64 = 60_000; // how often a copy looks for a newer file

pub type Http = Box<dyn Fn(&str, &[(String, String)]) -> Result<Value, String> + Send + Sync>;

pub enum Store {
    Memory,
    S3(Bucket),
}

pub struct Doc {
    pub body: Arc<Vec<u8>>,
    pub fetched_ms: i64,
}

pub struct Readings {
    http: Http,
    store: Store,
    stations_url: String,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    current: Mutex<Option<(i64, Arc<Doc>)>>, // (checked at, doc)
    refreshing: Mutex<()>,
}

impl Readings {
    pub fn new(http: Http, store: Store, stations_url: String, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Readings { http, store, stations_url, now, current: Mutex::new(None), refreshing: Mutex::new(()) }
    }

    fn stations(&self) -> Result<(HashSet<String>, HashSet<String>), String> {
        let v = (self.http)(&self.stations_url, &[])?;
        let set = |k: &str| -> HashSet<String> { v[k].as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default() };
        let (l, s) = (set("level"), set("storage"));
        if l.is_empty() {
            return Err(format!("no stations listed at {}", self.stations_url));
        }
        Ok((l, s))
    }

    /// Fetch everything again and store it. Returns a short summary.
    pub fn refresh(&self) -> Result<Value, String> {
        let _one = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
        let started = (self.now)();
        let (level, storage) = self.stations()?;
        let mut errors = Vec::new();
        let http = |u: &str, p: &[(String, String)]| (self.http)(u, p);
        let mut r = feeds::readings(&http, &level, &storage, started / 1000, &mut errors);
        let nl = r["level"].as_object().map_or(0, |o| o.len());
        let ns = r["storage"].as_object().map_or(0, |o| o.len());
        if nl == 0 && ns == 0 {
            return Err(format!("no readings fetched: {}", errors.first().cloned().unwrap_or_default()));
        }
        let rt = feeds::realtime_count(&r);
        let fetched = (self.now)();
        r["fetched"] = json!(crate::wmip::iso_utc(fetched));
        r["errors"] = json!(errors.iter().take(20).collect::<Vec<_>>());
        r["attribution"] = json!(format!("© Commonwealth of Australia (Bureau of Meteorology); Queensland live levels {}", feeds::WMIP_ATTRIBUTION));
        let body = serde_json::to_vec(&r).map_err(|e| e.to_string())?;
        if let Store::S3(b) = &self.store {
            b.put(KEY, &body, "application/json", fetched)?;
        }
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((fetched, Arc::new(Doc { body: Arc::new(body), fetched_ms: fetched })));
        Ok(json!({"levels": nl, "storages": ns, "liveQueensland": rt, "errors": errors.len(), "seconds": (fetched - started) / 1000}))
    }

    /// The latest readings, if there are any yet.
    pub fn latest(&self) -> Result<Option<Arc<Doc>>, String> {
        let now = (self.now)();
        let cur = self.current.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match &self.store {
            Store::Memory => Ok(cur.map(|c| c.1)),
            Store::S3(b) => {
                if let Some((checked, doc)) = &cur {
                    if now - checked < S3_CHECK_MS {
                        return Ok(Some(doc.clone()));
                    }
                }
                match b.get(KEY, now) {
                    Ok(Some(body)) => {
                        let fetched_ms = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["fetched"].as_str().and_then(crate::wmip::epoch_ms)).unwrap_or(now);
                        let doc = Arc::new(Doc { body: Arc::new(body), fetched_ms });
                        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                        Ok(Some(doc))
                    }
                    Ok(None) => Ok(None),
                    // S3 trouble: the copy in hand, if any
                    Err(e) => cur.map(|c| Some(c.1)).ok_or(e),
                }
            }
        }
    }
}

/// The real network call for the feeds: three tries, two-minute budget.
pub fn http_json(url: &str, params: &[(String, String)]) -> Result<Value, String> {
    let full = if params.is_empty() {
        url.to_string()
    } else {
        format!("{}{}{}", url, if url.contains('?') { "&" } else { "?" }, params.iter().map(|(k, v)| format!("{}={}", feeds::encode(k), feeds::encode(v))).collect::<Vec<_>>().join("&"))
    };
    let mut last = String::new();
    for attempt in 0..3u64 {
        match crate::fetch_with_timeout(&full, 120) {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_secs(5 * (attempt + 1)));
        }
    }
    Err(format!("{}: {}", &full[..full.len().min(120)], last))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn fake(url: &str, ps: &[(String, String)]) -> Result<Value, String> {
        let param = |k: &str| ps.iter().find(|x| x.0 == k).map(|x| x.1.as_str());
        if url == STATIONS_URL {
            return Ok(json!({"level": ["143001C", "540198"], "storage": ["143001A"]}));
        }
        if url.starts_with(feeds::WMIP) {
            let q: Value = serde_json::from_str(&crate::wmip::decode(url.split_once('?').unwrap().1)).unwrap();
            return Ok(if q["function"] == "get_site_list" {
                json!({"error_num": 0, "return": {"sites": ["143001C"]}})
            } else {
                json!({"error_num": 0, "return": {"traces": [{"site": "143001C", "trace": [{"v": "3.5", "t": 20261020170000u64, "q": 10}]}]}})
            });
        }
        Ok(match (param("request"), param("parametertype_name"), param("ts_name")) {
            (Some("getTimeseriesList"), Some("Storage Volume"), _) => json!([["station_no", "ts_id"], ["143001A", "9"]]),
            (Some("getTimeseriesList"), _, Some(t)) if t == feeds::HOURLY => json!([["station_no", "ts_id"], ["540198", "8"]]),
            (Some("getTimeseriesList"), _, _) => json!([["station_no", "ts_id"], ["143001C", "7"], ["540198", "6"]]),
            _ => {
                let mut out = Vec::new();
                for id in param("ts_id").unwrap().split(',') {
                    let d = match id {
                        "7" => json!([["2026-10-19T00:00:00.000+10:00", 1.0]]),
                        "6" => json!([["2026-10-19T00:00:00.000+10:00", 0.8]]),
                        "8" => json!([["2026-10-20T09:00:00.000+10:00", 0.9]]),
                        "9" => json!([["2026-10-19T00:00:00.000+10:00", 900000.0]]),
                        _ => continue,
                    };
                    out.push(json!({"ts_id": id, "data": d}));
                }
                Value::Array(out)
            }
        })
    }

    #[test]
    fn refresh_builds_the_readings_file() {
        let t = Arc::new(AtomicI64::new(crate::wmip::epoch_ms("2026-10-20T08:00:00Z").unwrap()));
        let t2 = t.clone();
        let r = Readings::new(Box::new(fake), Store::Memory, STATIONS_URL.into(), Box::new(move || t2.load(Ordering::SeqCst)));
        assert!(r.latest().unwrap().is_none());
        let s = r.refresh().unwrap();
        assert_eq!(s["levels"], 2);
        assert_eq!(s["liveQueensland"], 1);
        let doc = r.latest().unwrap().unwrap();
        let v: Value = serde_json::from_slice(&doc.body).unwrap();
        assert_eq!(v["level"]["143001C"]["latestKind"], "realtime");
        assert_eq!(v["level"]["143001C"]["latest"][1], 3.5);
        assert_eq!(v["level"]["540198"]["latestKind"], "hourly");
        assert_eq!(v["storage"]["143001A"]["latest"][1], 900000.0);
        assert_eq!(v["fetched"], "2026-10-20T08:00:00Z");
        assert_eq!(v["series"], feeds::DAILY);
    }

    #[test]
    fn a_failed_refresh_keeps_the_last_good_file() {
        let ok = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let ok2 = ok.clone();
        let http = move |u: &str, p: &[(String, String)]| if ok2.load(Ordering::SeqCst) { fake(u, p) } else { Err("blocked".to_string()) };
        let r = Readings::new(Box::new(http), Store::Memory, STATIONS_URL.into(), Box::new(|| 1_800_000_000_000));
        r.refresh().unwrap();
        ok.store(false, Ordering::SeqCst);
        assert!(r.refresh().is_err());
        assert!(r.latest().unwrap().is_some());
    }
}
