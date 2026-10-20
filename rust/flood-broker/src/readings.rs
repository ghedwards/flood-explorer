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
pub type Text = Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

const RAIN_EVERY_MS: i64 = 3 * 3_600_000; // the forecast models run every 6 hours
const SEA_EVERY_MS: i64 = 30 * 60_000;

struct Stations {
    level: HashSet<String>,
    storage: HashSet<String>,
    coords: Vec<(String, f64, f64)>,
}

pub enum Store {
    Memory,
    S3(Bucket),
}

/// One version of the readings, ready to send: as is, gzipped (about a
/// tenth of the size), and its ETag so browsers can ask "has it changed?".
pub struct Doc {
    pub body: Arc<Vec<u8>>,
    pub gz: Arc<Vec<u8>>,
    pub etag: String,
    pub fetched_ms: i64,
    /// S3's ETag for the stored copy (for cheap "unchanged?" checks)
    pub s3_etag: Option<String>,
}

impl Doc {
    pub fn new(body: Vec<u8>, fetched_ms: i64, s3_etag: Option<String>) -> Doc {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(body.len() / 6), flate2::Compression::new(6));
        let gz = enc.write_all(&body).and_then(|_| enc.finish()).unwrap_or_default();
        let etag = format!("\"{}\"", &crate::s3::sha256_hex(&body)[..20]);
        Doc { body: Arc::new(body), gz: Arc::new(gz), etag, fetched_ms, s3_etag }
    }
}

pub struct Readings {
    http: Http,
    store: Store,
    stations_url: String,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    current: Mutex<Option<(i64, Arc<Doc>)>>, // (checked at, doc)
    refreshing: Mutex<()>,
    text: Option<Text>,
    pause: Box<dyn Fn() + Send + Sync>,
}

impl Readings {
    pub fn new(http: Http, store: Store, stations_url: String, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Readings { http, store, stations_url, now, current: Mutex::new(None), refreshing: Mutex::new(()), text: None, pause: Box::new(|| std::thread::sleep(std::time::Duration::from_secs(12))) }
    }

    /// Fetch plain-text files (the storm tide CSV) with this.
    pub fn with_text(mut self, text: Text) -> Self {
        self.text = Some(text);
        self
    }

    /// What to do between batches of rain forecasts (a pause, to stay inside
    /// Open-Meteo's per-minute limit).
    pub fn with_pause(mut self, pause: Box<dyn Fn() + Send + Sync>) -> Self {
        self.pause = pause;
        self
    }

    fn stations(&self) -> Result<Stations, String> {
        let v = (self.http)(&self.stations_url, &[])?;
        let set = |k: &str| -> HashSet<String> { v[k].as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default() };
        let (level, storage) = (set("level"), set("storage"));
        if level.is_empty() {
            return Err(format!("no stations listed at {}", self.stations_url));
        }
        let mut coords: Vec<(String, f64, f64)> = v["coords"].as_object().map(|o| o.iter().filter_map(|(k, c)| Some((k.clone(), c[0].as_f64()?, c[1].as_f64()?))).collect()).unwrap_or_default();
        coords.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Stations { level, storage, coords })
    }

    /// The previous readings' rain or sea part, if it is recent enough.
    fn carry(prev: &Option<Value>, key: &str, at_key: &str, now: i64, every: i64) -> Option<(Value, Value)> {
        let p = prev.as_ref()?;
        let at = p[at_key].as_str().and_then(crate::wmip::epoch_ms)?;
        (now - at < every && !p[key].is_null()).then(|| (p[key].clone(), p[at_key].clone()))
    }

    /// Fetch everything again and store it. Returns a short summary.
    pub fn refresh(&self) -> Result<Value, String> {
        let _one = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
        let started = (self.now)();
        let st = self.stations()?;
        let mut errors = Vec::new();
        let http = |u: &str, p: &[(String, String)]| (self.http)(u, p);
        let mut r = feeds::readings(&http, &st.level, &st.storage, started / 1000, &mut errors);
        let prev = self.latest().ok().flatten().and_then(|d| serde_json::from_slice::<Value>(&d.body).ok());
        // rain forecast near the flood network's gauges, every 3 hours
        if !st.coords.is_empty() {
            match Self::carry(&prev, "rain", "rainFetched", started, RAIN_EVERY_MS) {
                Some((rain, at)) => {
                    r["rain"] = rain;
                    r["rainFetched"] = at;
                }
                None => {
                    let (cells, of) = feeds::rain_cells(&st.coords, feeds::RAIN_MAX_POINTS);
                    let got = feeds::rain_forecast(&http, &cells, started / 1000, &*self.pause, &mut errors);
                    let mut rain = serde_json::Map::new();
                    for (s, i) in &of {
                        if let Some((a, b)) = got[*i] {
                            rain.insert(s.clone(), json!([a, b]));
                        }
                    }
                    if !rain.is_empty() {
                        r["rain"] = Value::Object(rain);
                        r["rainFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                        r["rainCells"] = json!(cells.len());
                    } else if let Some((rain, at)) = Self::carry(&prev, "rain", "rainFetched", started, 12 * 3_600_000) {
                        r["rain"] = rain;
                        r["rainFetched"] = at;
                    }
                }
            }
        }
        // Queensland's storm tide gauges, every 30 minutes
        if let Some(text) = &self.text {
            match Self::carry(&prev, "sea", "seaFetched", started, SEA_EVERY_MS) {
                Some((sea, at)) => {
                    r["sea"] = sea;
                    r["seaFetched"] = at;
                }
                None => match text(feeds::STORM_TIDE_CSV) {
                    Ok(csv) => {
                        let sea = feeds::parse_storm_tide(&csv);
                        if sea.as_object().is_some_and(|o| !o.is_empty()) {
                            r["sea"] = sea;
                            r["seaFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                        }
                    }
                    Err(e) => {
                        errors.push(format!("storm tide: {}", e));
                        if let Some((sea, at)) = Self::carry(&prev, "sea", "seaFetched", started, 6 * 3_600_000) {
                            r["sea"] = sea;
                            r["seaFetched"] = at;
                        }
                    }
                },
            }
        }
        r["watch"] = feeds::watch_list(&r);
        let nl = r["level"].as_object().map_or(0, |o| o.len());
        let ns = r["storage"].as_object().map_or(0, |o| o.len());
        if nl == 0 && ns == 0 {
            return Err(format!("no readings fetched: {}", errors.first().cloned().unwrap_or_default()));
        }
        let rt = feeds::realtime_count(&r);
        let fetched = (self.now)();
        r["fetched"] = json!(crate::wmip::iso_utc(fetched));
        r["errors"] = json!(errors.iter().take(20).collect::<Vec<_>>());
        r["attribution"] = json!(format!("© Commonwealth of Australia (Bureau of Meteorology); Queensland live levels {}; {}; {}", feeds::WMIP_ATTRIBUTION, feeds::STORM_TIDE_ATTRIBUTION, feeds::RAIN_ATTRIBUTION));
        let body = serde_json::to_vec(&r).map_err(|e| e.to_string())?;
        if let Store::S3(b) = &self.store {
            b.put(KEY, &body, "application/json", fetched)?;
        }
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((fetched, Arc::new(Doc::new(body, fetched, None))));
        let count = |k: &str| r[k].as_object().map_or(0, |o| o.len());
        Ok(json!({"levels": nl, "storages": ns, "liveQueensland": rt, "rainGauges": count("rain"), "seaGauges": count("sea"),
            "watch": r["watch"].as_array().map_or(0, |a| a.len()), "errors": errors.len(), "seconds": (fetched - started) / 1000}))
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
                // only download it again when it has changed
                let have = cur.as_ref().and_then(|c| c.1.s3_etag.clone());
                match b.get(KEY, have.as_deref(), now) {
                    Ok(crate::s3::Got::Unchanged) if cur.is_some() => {
                        let doc = cur.unwrap().1;
                        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                        Ok(Some(doc))
                    }
                    Ok(crate::s3::Got::Body(body, s3_etag)) => {
                        let fetched_ms = serde_json::from_slice::<Value>(&body).ok().and_then(|v| v["fetched"].as_str().and_then(crate::wmip::epoch_ms)).unwrap_or(now);
                        let doc = Arc::new(Doc::new(body, fetched_ms, s3_etag));
                        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                        Ok(Some(doc))
                    }
                    Ok(_) => Ok(None),
                    Err(e) => cur.map(|c| Some(c.1)).ok_or(e),
                }
            }
        }
    }
}

/// A plain-text GET (the storm tide CSV), two-minute budget.
pub fn http_text(url: &str) -> Result<String, String> {
    use std::io::Read;
    let t = Some(std::time::Duration::from_secs(120));
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_connect(Some(std::time::Duration::from_secs(30))).timeout_recv_response(t).timeout_recv_body(t).http_status_as_error(false).build().into();
    let mut r = agent.get(url).header("User-Agent", "flood-explorer-broker (+https://github.com/ghedwards/flood-explorer)").call().map_err(|e| e.to_string())?;
    let code = r.status().as_u16();
    let mut b = Vec::new();
    r.body_mut().as_reader().take(32 << 20).read_to_end(&mut b).map_err(|e| e.to_string())?;
    if code >= 400 {
        return Err(format!("HTTP {}", code));
    }
    Ok(String::from_utf8_lossy(&b).into_owned())
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
    fn rain_and_sea_join_the_readings_and_are_reused_between_their_refreshes() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = calls.clone();
        let http = move |u: &str, p: &[(String, String)]| -> Result<Value, String> {
            if u == STATIONS_URL {
                return Ok(json!({"level": ["143001C", "540198"], "storage": ["143001A"], "coords": {"143001C": [152.9, -27.55], "540198": [153.03, -27.47]}}));
            }
            if u == feeds::OPEN_METEO {
                c2.fetch_add(1, Ordering::SeqCst);
                let n = p.iter().find(|x| x.0 == "latitude").unwrap().1.split(',').count();
                let t0 = 1_792_540_800i64;
                let one = json!({"hourly": {"time": (0..96).map(|h| t0 + h * 3600).collect::<Vec<_>>(), "precipitation": vec![3.0; 96]}});
                return Ok(if n == 1 { one } else { Value::Array(vec![one; n]) });
            }
            fake(u, p)
        };
        let t = Arc::new(AtomicI64::new(1_792_540_800_000));
        let t2 = t.clone();
        let r = Readings::new(Box::new(http), Store::Memory, STATIONS_URL.into(), Box::new(move || t2.load(Ordering::SeqCst)))
            .with_text(Box::new(|_| Ok("Site, Seconds, DateTime, Water Level, Prediction, Residual, Latitude, Longitude\nwhyteislandnx,1792530000,2026-10-21T07:00,1.993,1.501,0.492,-27.4017,153.1574\n".into())))
            .with_pause(Box::new(|| {}));
        let s = r.refresh().unwrap();
        assert_eq!(s["rainGauges"], 2);
        assert_eq!(s["seaGauges"], 1);
        let v: Value = serde_json::from_slice(&r.latest().unwrap().unwrap().body).unwrap();
        assert_eq!(v["rain"]["540198"][0], 72.0, "3 mm an hour for 24 hours");
        assert!(v["watch"].as_array().unwrap().iter().any(|w| w["kind"] == "sea"), "a 0.49 m surge is on the watch list");
        assert!(v["watch"].as_array().unwrap().iter().any(|w| w["station"] == "540198"), "72 mm of rain forecast is on the watch list");
        let n = calls.load(Ordering::SeqCst);
        t.fetch_add(15 * 60_000, Ordering::SeqCst);
        r.refresh().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), n, "rain reused within 3 hours");
        let v: Value = serde_json::from_slice(&r.latest().unwrap().unwrap().body).unwrap();
        assert_eq!(v["rain"]["540198"][0], 72.0);
        t.fetch_add(3 * 3_600_000, Ordering::SeqCst);
        r.refresh().unwrap();
        assert!(calls.load(Ordering::SeqCst) > n, "fetched again after 3 hours");
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
