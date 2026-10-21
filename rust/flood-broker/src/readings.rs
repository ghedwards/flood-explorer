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
/// The same, gzipped: what a cold start loads (unzipping is quick; zipping
/// 2 MB again on a small Lambda took long enough for browsers to give up).
const KEY_GZ: &str = "readings.json.gz";
/// The rolling hourly record of every gauge (history.rs).
const KEY_HIST: &str = "readings-history.json.gz";
const S3_CHECK_MS: i64 = 60_000; // how often a copy looks for a newer file

pub type Http = Box<dyn Fn(&str, &[(String, String)]) -> Result<Value, String> + Send + Sync>;
pub type Text = Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

const RAIN_EVERY_MS: i64 = 3 * 3_600_000; // the forecast models run every 6 hours
const SEA_EVERY_MS: i64 = 30 * 60_000;
/// Rain forecasts get this long; batches left over wait for the next refresh.
const RAIN_DEADLINE_MS: i64 = 150_000;

struct Stations {
    level: HashSet<String>,
    storage: HashSet<String>,
    coords: Vec<(String, f64, f64)>,
    /// Bureau number -> station, and station -> state
    bom: std::collections::HashMap<String, String>,
    state: std::collections::HashMap<String, String>,
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
    /// where this copy came from: "refresh", "s3-gz" (the zipped copy) or "s3"
    pub source: &'static str,
}

impl Doc {
    pub fn new(body: Vec<u8>, fetched_ms: i64, s3_etag: Option<String>) -> Doc {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(body.len() / 6), flate2::Compression::new(6));
        let gz = enc.write_all(&body).and_then(|_| enc.finish()).unwrap_or_default();
        let etag = format!("\"{}\"", &crate::s3::sha256_hex(&body)[..20]);
        Doc { body: Arc::new(body), gz: Arc::new(gz), etag, fetched_ms, s3_etag, source: "refresh" }
    }

    /// From the stored gzipped copy: unzip it, keep the zipped bytes to send.
    pub fn from_gz(gz: Vec<u8>, fetched_ms: Option<i64>, s3_etag: Option<String>) -> Result<Doc, String> {
        use std::io::Read;
        let mut body = Vec::with_capacity(gz.len() * 10);
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut body).map_err(|e| format!("readings.json.gz: {e}"))?;
        let fetched_ms = fetched_ms.or_else(|| doc_fetched(&body)).unwrap_or(0);
        let etag = format!("\"{}\"", &crate::s3::sha256_hex(&body)[..20]);
        Ok(Doc { body: Arc::new(body), gz: Arc::new(gz), etag, fetched_ms, s3_etag, source: "s3-gz" })
    }
}

fn doc_fetched(body: &[u8]) -> Option<i64> {
    serde_json::from_slice::<Value>(body).ok().and_then(|v| v["fetched"].as_str().and_then(crate::wmip::epoch_ms))
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
    rain_http: Option<Http>,
    warnings: Option<Warnings>,
    classes: Option<Classes>,
    history: Mutex<Option<HistoryCopy>>,
}

/// The hourly record as this copy last read it: (checked at, record, S3 ETag).
type HistoryCopy = (i64, Arc<crate::history::History>, Option<String>);

/// Fetches flood class levels and current classes: errors -> {station: ...}.
pub type Classes = Box<dyn Fn(&mut Vec<String>) -> Value + Send + Sync>;
const CLASSES_EVERY_MS: i64 = 60 * 60_000;

/// Fetches the current flood warnings: (now, iso now, errors) -> warnings.json.
pub type Warnings = Box<dyn Fn(i64, &str, &mut Vec<String>) -> Value + Send + Sync>;

impl Readings {
    pub fn new(http: Http, store: Store, stations_url: String, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Readings { http, store, stations_url, now, current: Mutex::new(None), refreshing: Mutex::new(()), text: None, pause: Box::new(|| std::thread::sleep(std::time::Duration::from_secs(12))), rain_http: None, warnings: None, classes: None, history: Mutex::new(None) }
    }

    /// Fetch plain-text files (the storm tide CSV) with this.
    pub fn with_text(mut self, text: Text) -> Self {
        self.text = Some(text);
        self
    }

    /// Fetch the Bureau's flood class levels with this (hourly).
    pub fn with_classes(mut self, c: Classes) -> Self {
        self.classes = Some(c);
        self
    }

    /// Fetch the Bureau's flood warnings with this.
    pub fn with_warnings(mut self, w: Warnings) -> Self {
        self.warnings = Some(w);
        self
    }

    /// Fetch rain forecasts with this (one quick try, no retries).
    pub fn with_rain_http(mut self, h: Http) -> Self {
        self.rain_http = Some(h);
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
        let map = |k: &str| -> std::collections::HashMap<String, String> { v[k].as_object().map(|o| o.iter().filter_map(|(a, b)| Some((a.clone(), b.as_str()?.to_string()))).collect()).unwrap_or_default() };
        Ok(Stations { level, storage, coords, bom: map("bom"), state: map("state") })
    }

    /// The previous readings' rain or sea part, if it is recent enough.
    fn carry(prev: &Option<Value>, key: &str, at_key: &str, now: i64, every: i64) -> Option<(Value, Value)> {
        let p = prev.as_ref()?;
        let at = p[at_key].as_str().and_then(crate::wmip::epoch_ms)?;
        (now - at < every && !p[key].is_null()).then(|| (p[key].clone(), p[at_key].clone()))
    }

    /// Each warning's area from the Bureau's flood warning catchments (its
    /// National Flood Gauge Network map service), by the area codes in the
    /// warning or its product ID, as "polygons" ([[lat, lon], ...] rings)
    /// and "areaNames". The CAP files carry no outlines, and browsers can't
    /// ask that service themselves (no CORS). A warning's areas are reused
    /// from the last refresh while its codes are the same.
    fn warning_areas(&self, warnings: &mut Value, prev: &Option<Value>, errors: &mut Vec<String>) {
        let Some(list) = warnings["warnings"].as_array_mut() else { return };
        let old: Vec<Value> = prev.as_ref().and_then(|p| p["warnings"]["warnings"].as_array().cloned()).unwrap_or_default();
        for w in list.iter_mut().take(40) {
            if w["polygons"].as_array().is_some_and(|a| !a.is_empty()) {
                continue;
            }
            let id = w["id"].as_str().unwrap_or("").to_string();
            let codes: Vec<String> = w["geocodes"].as_array().map(|a| a.iter().filter_map(|c| c.as_str()).filter(|c| feeds::is_area_code(c)).map(String::from).collect()).unwrap_or_default();
            if let Some(o) = old.iter().find(|o| o["id"] == w["id"] && o["geocodes"] == w["geocodes"] && o["polygons"].as_array().is_some_and(|a| !a.is_empty())) {
                w["polygons"] = o["polygons"].clone();
                w["areaNames"] = o["areaNames"].clone();
                continue;
            }
            let mut wheres = Vec::new();
            if !codes.is_empty() {
                wheres.push(format!("aac IN ({})", codes.iter().map(|c| format!("'{}'", c)).collect::<Vec<_>>().join(",")));
            }
            if feeds::is_product_id(&id) {
                wheres.push(format!("product_id='{}'", id));
            }
            for wh in wheres {
                let params: Vec<(String, String)> = [("where", wh.as_str()), ("outFields", "aac,dist_name"), ("returnGeometry", "true"), ("outSR", "4326"), ("maxAllowableOffset", "0.005"), ("geometryPrecision", "3"), ("f", "geojson")]
                    .iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
                match (self.http)(feeds::WARNING_AREAS, &params) {
                    Ok(gj) => {
                        let (rings, names) = feeds::geojson_rings(&gj);
                        if !rings.is_empty() {
                            w["polygons"] = json!(rings);
                            w["areaNames"] = json!(names);
                            break;
                        }
                    }
                    Err(e) => {
                        errors.push(format!("warning areas {}: {}", id, e));
                        break;
                    }
                }
            }
        }
    }

    /// Fetch everything again and store it. Returns a short summary.
    pub fn refresh(&self) -> Result<Value, String> {
        let _one = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
        let started = (self.now)();
        let st = self.stations()?;
        let mut errors = Vec::new();
        let http = |u: &str, p: &[(String, String)]| (self.http)(u, p);
        let mut r = feeds::readings(&http, &st.level, &st.storage, started / 1000, &mut errors);
        let t_readings = (self.now)();
        let prev = self.latest().ok().flatten().and_then(|d| serde_json::from_slice::<Value>(&d.body).ok());
        // rain forecast near the flood network's gauges, every 3 hours
        if !st.coords.is_empty() {
            // reused for 3 hours, unless the last fetch left gauges out
            let complete = prev.as_ref().is_none_or(|p| p["rainMissing"].as_u64().unwrap_or(0) == 0);
            match Self::carry(&prev, "rain", "rainFetched", started, RAIN_EVERY_MS).filter(|_| complete) {
                Some((rain, at)) => {
                    r["rain"] = rain;
                    r["rainFetched"] = at;
                }
                None => {
                    let (cells, of) = feeds::rain_cells(&st.coords, feeds::RAIN_MAX_POINTS);
                    let rain_http = |u: &str, p: &[(String, String)]| match &self.rain_http { Some(h) => h(u, p), None => (self.http)(u, p) };
                    // rain gets its own budget; what doesn't arrive waits for the next refresh
                    let rain_started = (self.now)();
                    let time_left = || (self.now)() - rain_started < RAIN_DEADLINE_MS;
                    let got = feeds::rain_forecast(&rain_http, &cells, started / 1000, &*self.pause, &time_left, &mut errors);
                    // cells that didn't arrive keep their last forecast
                    let old = prev.as_ref().map(|p| p["rain"].clone()).unwrap_or(Value::Null);
                    let mut rain = serde_json::Map::new();
                    for (s, i) in &of {
                        if let Some((a, b)) = got[*i] {
                            rain.insert(s.clone(), json!([a, b]));
                        } else if let Some(o) = old.get(s) {
                            rain.insert(s.clone(), o.clone());
                        }
                    }
                    if !rain.is_empty() {
                        r["rain"] = Value::Object(rain);
                        r["rainFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                        r["rainCells"] = json!(cells.len());
                        // cells that didn't arrive: try again next refresh, not in 3 hours
                        r["rainMissing"] = json!(got.iter().filter(|x| x.is_none()).count());
                    } else if let Some((rain, at)) = Self::carry(&prev, "rain", "rainFetched", started, 12 * 3_600_000) {
                        r["rain"] = rain;
                        r["rainFetched"] = at;
                    }
                }
            }
        }
        let t_rain = (self.now)();
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
        let t_sea = (self.now)();
        // the Bureau's flood warnings, every refresh; a failed fetch keeps the last list (for 6 hours)
        if let Some(wf) = &self.warnings {
            let w = wf(started / 1000, &crate::wmip::iso_utc((self.now)()), &mut errors);
            if w["ok"] == json!(true) {
                r["warnings"] = w;
            } else if let Some((old, _)) = Self::carry(&prev, "warnings", "warningsFetched", started, 6 * 3_600_000) {
                r["warnings"] = old;
            }
            if r["warnings"]["ok"] == json!(true) {
                r["warningsFetched"] = r["warnings"]["fetched"].clone();
            }
            self.warning_areas(&mut r["warnings"], &prev, &mut errors);
        }
        // flood class levels and the Bureau's current class at each gauge, hourly
        if let Some(cf) = &self.classes {
            match Self::carry(&prev, "floodclass", "floodclassFetched", started, CLASSES_EVERY_MS) {
                Some((fc, at)) => {
                    r["floodclass"] = fc;
                    r["floodclassFetched"] = at;
                }
                None => {
                    let mut fc = cf(&mut errors);
                    // gauges this fetch didn't reach keep their last entry (a day at most)
                    if let (Some(new), Some((old, _))) = (fc.as_object_mut(), Self::carry(&prev, "floodclass", "floodclassFetched", started, 24 * 3_600_000)) {
                        if !new.is_empty() {
                            for (k, v) in old.as_object().into_iter().flatten() {
                                new.entry(k.clone()).or_insert_with(|| v.clone());
                            }
                        }
                    }
                    if fc.as_object().is_some_and(|o| !o.is_empty()) {
                        r["floodclass"] = fc;
                        r["floodclassFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                    } else if let Some((fc, at)) = Self::carry(&prev, "floodclass", "floodclassFetched", started, 24 * 3_600_000) {
                        r["floodclass"] = fc;
                        r["floodclassFetched"] = at;
                    }
                }
            }
        }
        // the Bureau's river height levels as the level now where they're newer
        if !st.bom.is_empty() && r["floodclass"].is_object() {
            let fc = r["floodclass"].clone();
            let n = feeds::bureau_levels(&mut r["level"], &fc, &st.bom, &st.state);
            r["bureauLevels"] = json!(n);
        }
        let t_warn = (self.now)();
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
        let doc = Doc::new(body, fetched, None);
        let mut gz_stored: Option<bool> = None;   // None: no S3 (a server keeps it in memory)
        if let Store::S3(b) = &self.store {
            b.put(KEY, &doc.body, "application/json", fetched)?;
            // best effort: a stack set up before this allows only readings.json
            if !doc.gz.is_empty() {
                match b.put(KEY_GZ, &doc.gz, "application/gzip", fetched) {
                    Ok(()) => gz_stored = Some(true),
                    Err(e) => {
                        eprintln!("readings.json.gz not stored ({e}); cold starts zip readings.json instead");
                        gz_stored = Some(false);
                    }
                }
            }
        }
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((fetched, Arc::new(doc)));
        let hist = self.update_history(&r["level"], fetched);
        let count = |k: &str| r[k].as_object().map_or(0, |o| o.len());
        Ok(json!({"levels": nl, "storages": ns, "liveQueensland": rt, "rainGauges": count("rain"), "seaGauges": count("sea"),
            "watch": r["watch"].as_array().map_or(0, |a| a.len()), "errors": errors.len(), "gzStored": gz_stored, "version": crate::VERSION, "history": hist, "seconds": (fetched - started) / 1000,
            "warnings": r["warnings"]["warnings"].as_array().map(|a| a.len()),
            "floodClasses": r["floodclass"].as_object().map(|o| o.len()),
            "stageSeconds": {"readings": (t_readings - started) / 1000, "rain": (t_rain - t_readings) / 1000, "sea": (t_sea - t_rain) / 1000, "warnings": (t_warn - t_sea) / 1000}}))
    }

    /// The stored hourly record (S3: re-read when it has changed, checked at
    /// most once a minute; a server keeps it in memory).
    fn load_history(&self, now: i64) -> Result<Arc<crate::history::History>, String> {
        use crate::history::{gunzip, History};
        let cur = self.history.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Store::S3(b) = &self.store else {
            return Ok(cur.map(|c| c.1).unwrap_or_default());
        };
        if let Some((checked, h, _)) = &cur {
            if now - checked < S3_CHECK_MS {
                return Ok(h.clone());
            }
        }
        let have = cur.as_ref().and_then(|c| c.2.clone());
        let got = match b.get(KEY_HIST, have.as_deref(), now) {
            Ok(crate::s3::Got::Unchanged) => cur.as_ref().map(|c| (c.1.clone(), c.2.clone())),
            Ok(crate::s3::Got::Body(z, etag)) => {
                let v: Value = serde_json::from_slice(&gunzip(&z)?).map_err(|e| e.to_string())?;
                Some((Arc::new(History::from_json(&v)), etag))
            }
            Ok(_) => Some((Arc::new(History::default()), None)),
            Err(e) => return cur.map(|c| c.1).ok_or(e),
        };
        let (h, etag) = got.unwrap_or_default();
        *self.history.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, h.clone(), etag));
        Ok(h)
    }

    /// Adds this refresh's levels to the record and stores it (best effort:
    /// a failure here never fails the refresh).
    fn update_history(&self, level: &Value, now: i64) -> Value {
        let mut h = match self.load_history(now) {
            Ok(h) => (*h).clone(),
            Err(e) => return json!({"error": e}),
        };
        let added = h.add(level, now);
        let sites = h.sites.len();
        let hours: usize = h.sites.values().map(|p| p.len()).sum();
        let mut stored = None;
        if let Store::S3(b) = &self.store {
            let z = crate::history::gzip(&serde_json::to_vec(&h.to_json()).unwrap_or_default());
            stored = Some(match b.put(KEY_HIST, &z, "application/gzip", now) {
                Ok(()) => json!(z.len()),
                Err(e) => {
                    eprintln!("{} not stored: {}", KEY_HIST, e);
                    json!(false)
                }
            });
        }
        // the next read fetches what was just stored (its ETag is new)
        *self.history.lock().unwrap_or_else(|e| e.into_inner()) = Some((if stored.is_some() { 0 } else { now }, Arc::new(h), None));
        json!({"added": added, "sites": sites, "hours": hours, "storedBytes": stored})
    }

    /// One gauge's hourly record for the last week.
    pub fn history_site(&self, st: &str) -> Result<Option<Value>, String> {
        Ok(self.load_history((self.now)())?.site(st))
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
                // the gzipped copy first (older stores have only the plain one)
                match b.get(KEY_GZ, have.as_deref(), now) {
                    Ok(crate::s3::Got::Unchanged) if cur.is_some() => {
                        let doc = cur.unwrap().1;
                        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                        return Ok(Some(doc));
                    }
                    Ok(crate::s3::Got::Body(gz, s3_etag)) => {
                        if let Ok(doc) = Doc::from_gz(gz, None, s3_etag) {
                            let doc = Arc::new(doc);
                            *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                            return Ok(Some(doc));
                        }
                    }
                    _ => {}
                }
                match b.get(KEY, have.as_deref(), now) {
                    Ok(crate::s3::Got::Unchanged) if cur.is_some() => {
                        let doc = cur.unwrap().1;
                        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                        Ok(Some(doc))
                    }
                    Ok(crate::s3::Got::Body(body, s3_etag)) => {
                        let fetched_ms = doc_fetched(&body).unwrap_or(now);
                        let mut doc = Doc::new(body, fetched_ms, s3_etag);
                        doc.source = "s3";
                        let doc = Arc::new(doc);
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

/// One quick JSON GET, no retries (rain forecasts: a slow batch waits for
/// the next refresh rather than holding this one up).
pub fn http_json_once(url: &str, params: &[(String, String)]) -> Result<Value, String> {
    let full = format!("{}?{}", url, params.iter().map(|(k, v)| format!("{}={}", feeds::encode(k), feeds::encode(v))).collect::<Vec<_>>().join("&"));
    crate::fetch_with_timeout(&full, 25)
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
    #[test]
    fn a_stored_gzipped_copy_loads_as_the_same_document() {
        let body = br#"{"fetched":"2026-10-21T01:24:04Z","level":{"1":{"latest":["x",1.5]}}}"#.to_vec();
        let a = super::Doc::new(body.clone(), 0, None);
        let b = super::Doc::from_gz(a.gz.as_ref().clone(), None, Some("e".into())).unwrap();
        assert_eq!(*b.body, body);
        assert_eq!(b.etag, a.etag, "same ETag for browsers either way");
        assert_eq!(b.fetched_ms, crate::wmip::epoch_ms("2026-10-21T01:24:04Z").unwrap());
        assert!(super::Doc::from_gz(b"not gzip".to_vec(), None, None).is_err());
    }

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
        assert!(s["history"]["sites"].as_u64().unwrap() >= 1, "the hourly record starts: {}", s["history"]);
        let h = r.history_site("143001C").unwrap().expect("a live gauge has a record");
        assert_eq!(h.as_array().unwrap().last().unwrap()[1], 3.5);
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
        assert_eq!(v["sea"]["whyteislandnx"]["residual"], 0.492);
        assert!(!v["watch"].as_array().unwrap().iter().any(|w| w["kind"] == "sea"), "one reading: no usual residual to measure a surge against");
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
