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
/// The Bureau FTP directory's last seen `{name: [version, parsed]}` so
/// unchanged warning and river-height files aren't downloaded again.
const KEY_FTP: &str = "readings-ftp-index.json.gz";
const S3_CHECK_MS: i64 = 60_000; // how often a copy looks for a newer file

pub type Http = Box<dyn Fn(&str, &[(String, String)]) -> Result<Value, String> + Send + Sync>;
pub type Text = Box<dyn Fn(&str) -> Result<String, String> + Send + Sync>;

const RAIN_EVERY_MS: i64 = 3 * 3_600_000; // the forecast models run every 6 hours
const SEA_EVERY_MS: i64 = 30 * 60_000;
const ROADS_EVERY_MS: i64 = 30 * 60_000;
/// Once QLDTraffic returns HTTP 429 its key's quota is spent, often for the
/// rest of the day; retrying every half hour can't earn events, so wait an
/// hour between attempts (the last list still serves its 2-hour carry).
const ROADS_429_EVERY_MS: i64 = 60 * 60_000;
/// Water Data Online (a day behind anyway): at most this often.
const WDO_EVERY_MS: i64 = 60 * 60_000;
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
    Local(std::path::PathBuf),
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
    /// the same without each gauge's series (what the map polls), and the
    /// series by gauge: both made on first use
    pub now: std::sync::OnceLock<Part>,
    pub series: std::sync::OnceLock<std::collections::HashMap<String, Value>>,
}

/// One served form of a document: as is, gzipped, and its ETag.
pub struct Part {
    pub body: Arc<Vec<u8>>,
    pub gz: Arc<Vec<u8>>,
    pub etag: String,
}

fn gzip6(b: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(b.len() / 6), flate2::Compression::new(6));
    enc.write_all(b).and_then(|_| enc.finish()).unwrap_or_default()
}

impl Doc {
    /// readings.json without the per-gauge "series" of levels and storages
    /// (most of its size): what the map loads and polls (/v1/now).
    pub fn now_part(&self) -> &Part {
        self.now.get_or_init(|| {
            let mut v: Value = serde_json::from_slice(&self.body).unwrap_or(Value::Null);
            for k in ["level", "storage"] {
                if let Some(o) = v[k].as_object_mut() {
                    for e in o.values_mut() {
                        if let Some(m) = e.as_object_mut() {
                            m.remove("series");
                        }
                    }
                }
            }
            v["seriesOnDemand"] = json!(true);
            let body = serde_json::to_vec(&v).unwrap_or_default();
            let etag = format!("\"n{}\"", &crate::s3::sha256_hex(&body)[..19]);
            Part { gz: Arc::new(gzip6(&body)), body: Arc::new(body), etag }
        })
    }

    /// One gauge's or dam's series ("level" or "storage").
    pub fn series_of(&self, kind: &str, site: &str) -> Option<Value> {
        let m = self.series.get_or_init(|| {
            let v: Value = serde_json::from_slice(&self.body).unwrap_or(Value::Null);
            let mut m = std::collections::HashMap::new();
            for k in ["level", "storage"] {
                if let Some(o) = v[k].as_object() {
                    for (st, e) in o {
                        if let Some(sr) = e.get("series") {
                            m.insert(format!("{}:{}", k, st), sr.clone());
                        }
                    }
                }
            }
            m
        });
        m.get(&format!("{}:{}", kind, site)).cloned()
    }
}

impl Doc {
    pub fn new(body: Vec<u8>, fetched_ms: i64, s3_etag: Option<String>) -> Doc {
        use std::io::Write;
        let mut enc = flate2::write::GzEncoder::new(Vec::with_capacity(body.len() / 6), flate2::Compression::new(6));
        let gz = enc.write_all(&body).and_then(|_| enc.finish()).unwrap_or_default();
        let etag = format!("\"{}\"", &crate::s3::sha256_hex(&body)[..20]);
        Doc { body: Arc::new(body), gz: Arc::new(gz), etag, fetched_ms, s3_etag, source: "refresh", now: Default::default(), series: Default::default() }
    }

    /// From the stored gzipped copy: unzip it, keep the zipped bytes to send.
    pub fn from_gz(gz: Vec<u8>, fetched_ms: Option<i64>, s3_etag: Option<String>) -> Result<Doc, String> {
        use std::io::Read;
        let mut body = Vec::with_capacity(gz.len() * 10);
        flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut body).map_err(|e| format!("readings.json.gz: {e}"))?;
        let fetched_ms = fetched_ms.or_else(|| doc_fetched(&body)).unwrap_or(0);
        let etag = format!("\"{}\"", &crate::s3::sha256_hex(&body)[..20]);
        Ok(Doc { body: Arc::new(body), gz: Arc::new(gz), etag, fetched_ms, s3_etag, source: "s3-gz", now: Default::default(), series: Default::default() })
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
    ftp: Option<FtpOpen>,
    ftp_index: Mutex<std::collections::HashMap<String, (String, Value)>>,
    roads: Option<RoadsFetch>,
    emergency: Option<EmergencyFetch>,
    history: Mutex<Option<HistoryCopy>>,
}

/// The hourly record as this copy last read it: (checked at, record, S3 ETag).
type HistoryCopy = (i64, Arc<crate::history::History>, Option<String>);

/// Opens a session to the Bureau's FTP server (one per refresh for both
/// flood warnings and river height / flood class pages).
pub type FtpOpen = Box<dyn Fn() -> Result<Box<dyn feeds::ftp::Dir>, String> + Send + Sync>;

/// Fetches official flood road closures: `(iso_now, errors) -> roads_doc`.
pub type RoadsFetch = Box<dyn Fn(&str, &mut Vec<String>) -> Value + Send + Sync>;
pub type EmergencyFetch = Box<dyn Fn(&str, &mut Vec<String>) -> Value + Send + Sync>;

/// Fetches flood class levels and current classes: errors -> {station: ...}.
pub type Classes = Box<dyn Fn(&mut Vec<String>) -> Value + Send + Sync>;
const CLASSES_EVERY_MS: i64 = 60 * 60_000;

/// Fetches the current flood warnings: (now, iso now, errors) -> warnings.json.
pub type Warnings = Box<dyn Fn(i64, &str, &mut Vec<String>) -> Value + Send + Sync>;

impl Readings {
    pub fn new(http: Http, store: Store, stations_url: String, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Readings { http, store, stations_url, now, current: Mutex::new(None), refreshing: Mutex::new(()), text: None, pause: Box::new(|| std::thread::sleep(std::time::Duration::from_secs(12))), rain_http: None, warnings: None, classes: None, ftp: None, ftp_index: Mutex::new(Default::default()), roads: None, emergency: None, history: Mutex::new(None) }
    }

    /// Fetch both flood warnings and flood class / river height pages over
    /// one FTP session per refresh, downloading only changed files.
    pub fn with_ftp(mut self, f: FtpOpen) -> Self {
        self.ftp = Some(f);
        self
    }

    /// Fetch official flood road closures with this (every 30 minutes).
    pub fn with_roads(mut self, f: RoadsFetch) -> Self {
        self.roads = Some(f);
        self
    }

    pub fn with_emergency(mut self, f: EmergencyFetch) -> Self {
        self.emergency = Some(f);
        self
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
        // Water Data Online runs about a day behind and took ~95% of a
        // refresh: ask it at most hourly and reuse its levels and dam
        // volumes in between; Queensland's live levels (and the Bureau's FTP
        // levels further down) still come every refresh
        let prev0 = self.latest().ok().flatten().and_then(|d| serde_json::from_slice::<Value>(&d.body).ok());
        let reuse = prev0.as_ref().filter(|p| {
            p["wdoFetched"].as_str().and_then(crate::wmip::epoch_ms).is_some_and(|t| started - t < WDO_EVERY_MS) && p["level"].is_object()
        });
        let mut r = match reuse {
            Some(p) => {
                let mut level = p["level"].as_object().cloned().unwrap_or_default();
                let live = feeds::qld_realtime(&http, &st.level, started / 1000, &mut errors);
                feeds::apply_live(&mut level, live, "m");
                let mut r = json!({"level": Value::Object(level), "storage": p["storage"].clone(), "series": p["series"].clone(), "watchRule": p["watchRule"].clone()});
                r["wdoFetched"] = p["wdoFetched"].clone();
                r
            }
            None => {
                let mut r = feeds::readings(&http, &st.level, &st.storage, started / 1000, &mut errors);
                r["wdoFetched"] = json!(crate::wmip::iso_utc(started));
                r
            }
        };
        let t_readings = (self.now)();
        let prev = self.latest().ok().flatten().and_then(|d| serde_json::from_slice::<Value>(&d.body).ok());
        // Track per-source health across refreshes: lastGood, lastError, errorCount.
        let mut sources = prev.as_ref().and_then(|p| p["sources"].as_object().cloned()).unwrap_or_default();
        let mut mark_source = |name: &str, attempted: bool, ok: bool, slice: &[String], at_iso: &str| {
            let mut entry = sources.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
            if attempted {
                if ok && slice.is_empty() {
                    entry.insert("lastGood".into(), json!(at_iso));
                    entry.insert("lastError".into(), Value::Null);
                    entry.insert("errorCount".into(), json!(0));
                } else if ok {
                    entry.insert("lastGood".into(), json!(at_iso));
                    entry.insert("lastError".into(), json!(slice.last().cloned().unwrap_or_default()));
                    entry.insert("errorCount".into(), json!(slice.len()));
                } else {
                    let prev_n = entry.get("errorCount").and_then(Value::as_u64).unwrap_or(0);
                    entry.insert("lastError".into(), json!(slice.last().cloned().unwrap_or_else(|| "failed".into())));
                    entry.insert("errorCount".into(), json!(prev_n + slice.len().max(1) as u64));
                }
            }
            sources.insert(name.to_string(), Value::Object(entry));
        };
        let wdo_errs: Vec<String> = errors.iter().filter(|e| !e.starts_with("Queensland")).cloned().collect();
        let qld_errs: Vec<String> = errors.iter().filter(|e| e.starts_with("Queensland")).cloned().collect();
        let now_readings_iso = crate::wmip::iso_utc(t_readings);
        mark_source(
            "wdo",
            reuse.is_none(),
            r["level"].as_object().is_some_and(|o| !o.is_empty()) || r["storage"].as_object().is_some_and(|o| !o.is_empty()),
            &wdo_errs,
            r["wdoFetched"].as_str().unwrap_or(&now_readings_iso),
        );
        mark_source(
            "qld",
            true,
            feeds::realtime_count(&r) > 0 || qld_errs.is_empty(),
            &qld_errs,
            &now_readings_iso,
        );
        // rain forecast near the flood network's gauges, every 3 hours
        let mut rain_attempted = false;
        let err_before_rain = errors.len();
        if !st.coords.is_empty() {
            // reused for 3 hours, unless the last fetch left gauges out
            let complete = prev.as_ref().is_none_or(|p| p["rainMissing"].as_u64().unwrap_or(0) == 0);
            match Self::carry(&prev, "rain", "rainFetched", started, RAIN_EVERY_MS).filter(|_| complete) {
                Some((rain, at)) => {
                    r["rain"] = rain;
                    r["rainFetched"] = at;
                }
                None => {
                    rain_attempted = true;
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
                    let got_any = got.iter().any(Option::is_some);
                    if !rain.is_empty() {
                        r["rain"] = Value::Object(rain);
                        if got_any {
                            r["rainFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                        } else if let Some(at) = prev.as_ref().map(|p| p["rainFetched"].clone()).filter(|v| v.is_string()) {
                            r["rainFetched"] = at;
                        }
                        r["rainCells"] = json!(cells.len());
                        // cells that didn't arrive: try again next refresh, not in 3 hours
                        r["rainMissing"] = json!(got.iter().filter(|x| x.is_none()).count());
                    } else if let Some((rain, at)) = Self::carry(&prev, "rain", "rainFetched", started, 12 * 3_600_000) {
                        r["rain"] = rain;
                        r["rainFetched"] = at;
                    }
                    mark_source(
                        "rain",
                        true,
                        got_any,
                        &errors[err_before_rain..],
                        r["rainFetched"].as_str().unwrap_or(&crate::wmip::iso_utc((self.now)())),
                    );
                }
            }
        }
        if !rain_attempted && r["rainFetched"].is_string() {
            mark_source("rain", false, true, &[], r["rainFetched"].as_str().unwrap_or(""));
        }
        let t_rain = (self.now)();
        // Queensland's storm tide gauges, every 30 minutes
        let mut sea_attempted = false;
        let err_before_sea = errors.len();
        if let Some(text) = &self.text {
            match Self::carry(&prev, "sea", "seaFetched", (self.now)(), SEA_EVERY_MS) {
                Some((sea, at)) => {
                    r["sea"] = sea;
                    r["seaFetched"] = at;
                }
                None => {
                    sea_attempted = true;
                    let mut sea_ok = false;
                    match text(feeds::STORM_TIDE_CSV) {
                        Ok(csv) => {
                            let sea = feeds::parse_storm_tide(&csv);
                            if sea.as_object().is_some_and(|o| !o.is_empty()) {
                                r["sea"] = sea;
                                r["seaFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                                sea_ok = true;
                            }
                        }
                        Err(e) => {
                            errors.push(format!("storm tide: {}", e));
                            if let Some((sea, at)) = Self::carry(&prev, "sea", "seaFetched", (self.now)(), 6 * 3_600_000) {
                                r["sea"] = sea;
                                r["seaFetched"] = at;
                            }
                        }
                    }
                    mark_source(
                        "sea",
                        true,
                        sea_ok,
                        &errors[err_before_sea..],
                        r["seaFetched"].as_str().unwrap_or(&crate::wmip::iso_utc((self.now)())),
                    );
                }
            }
        }
        if !sea_attempted && r["seaFetched"].is_string() {
            mark_source("sea", false, true, &[], r["seaFetched"].as_str().unwrap_or(""));
        }
        let t_sea = (self.now)();
        // One FTP session for both flood warnings and flood class / river
        // height pages when `with_ftp` is set, downloading only files whose
        // LIST size/mtime changed since the last refresh.
        let mut ftp_downloads: Option<usize> = None;
        if let Some(open_ftp) = &self.ftp {
            let carried_fc = Self::carry(&prev, "floodclass", "floodclassFetched", started, CLASSES_EVERY_MS);
            let want_classes = carried_fc.is_none();
            if let Some((fc, at)) = carried_fc {
                r["floodclass"] = fc;
                r["floodclassFetched"] = at;
                if let Some((ro, ro_at)) = Self::carry(&prev, "rainObs", "rainObsFetched", started, CLASSES_EVERY_MS) {
                    r["rainObs"] = ro;
                    r["rainObsFetched"] = ro_at;
                }
            }
            let iso_now = crate::wmip::iso_utc((self.now)());
            let err_before_ftp = errors.len();
            let mut cache = self.load_ftp_index(started);
            let (w, fc_opt, ro_opt, dl) = match open_ftp() {
                Ok(mut dir) => feeds::flood_ftp_all(&mut *dir, &mut cache, started / 1000, &iso_now, want_classes, &mut errors),
                Err(e) => {
                    errors.push(format!("flood warnings: {}", e));
                    if want_classes {
                        errors.push(format!("flood classes: {}", e));
                    }
                    (json!({"ok": false, "fetched": iso_now, "source": "ftp", "warnings": [], "error": e}), want_classes.then(|| json!({})), want_classes.then(|| json!({})), 0)
                }
            };
            self.save_ftp_index(&cache, (self.now)());
            ftp_downloads = Some(dl);
            let w_ok = w["ok"] == json!(true);
            let ftp_errs: Vec<String> = errors[err_before_ftp..].iter().filter(|e| e.starts_with("flood warnings")).cloned().collect();
            if w_ok {
                r["warnings"] = w;
            } else if let Some((old, _)) = Self::carry(&prev, "warnings", "warningsFetched", started, 6 * 3_600_000) {
                r["warnings"] = old;
            }
            if r["warnings"]["ok"] == json!(true) {
                r["warningsFetched"] = r["warnings"]["fetched"].clone();
            }
            mark_source(
                "warnings",
                true,
                w_ok,
                &ftp_errs,
                r["warningsFetched"].as_str().unwrap_or(&iso_now),
            );
            let err_before_areas = errors.len();
            self.warning_areas(&mut r["warnings"], &prev, &mut errors);
            let area_errs = &errors[err_before_areas..];
            mark_source(
                "warningAreas",
                true,
                area_errs.is_empty(),
                area_errs,
                &crate::wmip::iso_utc((self.now)()),
            );
            if let Some(mut fc) = fc_opt {
                let fc_errs: Vec<String> = errors[err_before_ftp..err_before_areas].iter().filter(|e| e.starts_with("flood classes")).cloned().collect();
                if let (Some(new), Some((old, _))) = (fc.as_object_mut(), Self::carry(&prev, "floodclass", "floodclassFetched", started, 24 * 3_600_000)) {
                    if !new.is_empty() {
                        for (k, v) in old.as_object().into_iter().flatten() {
                            new.entry(k.clone()).or_insert_with(|| v.clone());
                        }
                    }
                }
                let fc_ok = fc.as_object().is_some_and(|o| !o.is_empty());
                if fc_ok {
                    r["floodclass"] = fc;
                    r["floodclassFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                } else if let Some((fc, at)) = Self::carry(&prev, "floodclass", "floodclassFetched", started, 24 * 3_600_000) {
                    r["floodclass"] = fc;
                    r["floodclassFetched"] = at;
                }
                mark_source(
                    "floodclass",
                    true,
                    fc_ok,
                    &fc_errs,
                    r["floodclassFetched"].as_str().unwrap_or(&iso_now),
                );
            } else if r["floodclassFetched"].is_string() {
                mark_source("floodclass", false, true, &[], r["floodclassFetched"].as_str().unwrap_or(""));
            }
            if let Some(ro) = ro_opt {
                if ro.as_object().is_some_and(|o| !o.is_empty()) {
                    r["rainObs"] = ro;
                    r["rainObsFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                } else if let Some((ro, at)) = Self::carry(&prev, "rainObs", "rainObsFetched", started, 24 * 3_600_000) {
                    r["rainObs"] = ro;
                    r["rainObsFetched"] = at;
                }
            }
        }
        // the Bureau's flood warnings, every refresh; a failed fetch keeps the last list (for 6 hours)
        if self.ftp.is_none() {
            if let Some(wf) = &self.warnings {
                let err_before_w = errors.len();
                let iso_now = crate::wmip::iso_utc((self.now)());
                let w = wf(started / 1000, &iso_now, &mut errors);
                let w_ok = w["ok"] == json!(true);
                let w_errs: Vec<String> = errors[err_before_w..].to_vec();
                if w_ok {
                    r["warnings"] = w;
                } else if let Some((old, _)) = Self::carry(&prev, "warnings", "warningsFetched", started, 6 * 3_600_000) {
                    r["warnings"] = old;
                }
                if r["warnings"]["ok"] == json!(true) {
                    r["warningsFetched"] = r["warnings"]["fetched"].clone();
                }
                mark_source("warnings", true, w_ok, &w_errs, r["warningsFetched"].as_str().unwrap_or(&iso_now));
                let err_before_areas = errors.len();
                self.warning_areas(&mut r["warnings"], &prev, &mut errors);
                let area_errs = &errors[err_before_areas..];
                mark_source("warningAreas", true, area_errs.is_empty(), area_errs, &crate::wmip::iso_utc((self.now)()));
            }
            // flood class levels and the Bureau's current class at each gauge, hourly
            if let Some(cf) = &self.classes {
                match Self::carry(&prev, "floodclass", "floodclassFetched", started, CLASSES_EVERY_MS) {
                    Some((fc, at)) => {
                        r["floodclass"] = fc;
                        r["floodclassFetched"] = at;
                        mark_source("floodclass", false, true, &[], r["floodclassFetched"].as_str().unwrap_or(""));
                    }
                    None => {
                        let err_before_fc = errors.len();
                        let mut fc = cf(&mut errors);
                        let fc_errs: Vec<String> = errors[err_before_fc..].to_vec();
                        // gauges this fetch didn't reach keep their last entry (a day at most)
                        if let (Some(new), Some((old, _))) = (fc.as_object_mut(), Self::carry(&prev, "floodclass", "floodclassFetched", started, 24 * 3_600_000)) {
                            if !new.is_empty() {
                                for (k, v) in old.as_object().into_iter().flatten() {
                                    new.entry(k.clone()).or_insert_with(|| v.clone());
                                }
                            }
                        }
                        let fc_ok = fc.as_object().is_some_and(|o| !o.is_empty());
                        if fc_ok {
                            r["floodclass"] = fc;
                            r["floodclassFetched"] = json!(crate::wmip::iso_utc((self.now)()));
                        } else if let Some((fc, at)) = Self::carry(&prev, "floodclass", "floodclassFetched", started, 24 * 3_600_000) {
                            r["floodclass"] = fc;
                            r["floodclassFetched"] = at;
                        }
                        mark_source("floodclass", true, fc_ok, &fc_errs, r["floodclassFetched"].as_str().unwrap_or(&crate::wmip::iso_utc((self.now)())));
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
        // Official flood road closures (QLDTraffic, and Live Traffic NSW when
        // NSW_TRAFFIC_API_KEY is set), every 30 minutes; carried up to 2 hours on error.
        if let Some(rf) = &self.roads {
            // QLDTraffic's quota exhausted (a 429 in the last attempt's
            // health): attempts earn nothing, so an hour between them
            let quota = prev.as_ref().and_then(|p| p["sources"]["roads"]["lastError"].as_str()).is_some_and(|e| e.contains("429"));
            match Self::carry(&prev, "roads", "roadsFetched", (self.now)(), if quota { ROADS_429_EVERY_MS } else { ROADS_EVERY_MS }) {
                Some((rd, at)) => {
                    r["roads"] = rd;
                    r["roadsFetched"] = at;
                    mark_source("roads", false, true, &[], r["roadsFetched"].as_str().unwrap_or(""));
                }
                None => {
                    let err_before_r = errors.len();
                    let iso_now = crate::wmip::iso_utc((self.now)());
                    let rd = rf(&iso_now, &mut errors);
                    let rd_errs: Vec<String> = errors[err_before_r..].to_vec();
                    let rd_ok = rd["sources"].as_object().is_some_and(|o| o.values().any(|v| v == "ok"));
                    if rd_ok {
                        r["roads"] = rd;
                        r["roadsFetched"] = json!(iso_now.clone());
                    } else if let Some((old, at)) = Self::carry(&prev, "roads", "roadsFetched", (self.now)(), 2 * 3_600_000) {
                        r["roads"] = old;
                        r["roadsFetched"] = at;
                    }
                    mark_source("roads", true, rd_ok, &rd_errs, r["roadsFetched"].as_str().unwrap_or(&iso_now));
                }
            }
        }
        // State emergency warnings (Australian Warning System), NSW first via
        // the RFS major incidents feed (public, no key); one HTTP fetch per
        // refresh, carried 15 minutes on error.
        if let Some(ef) = &self.emergency {
            match Self::carry(&prev, "emergency", "emergencyFetched", (self.now)(), 15 * 60_000) {
                Some((ed, at)) => {
                    r["emergency"] = ed;
                    r["emergencyFetched"] = at;
                    mark_source("emergency", false, true, &[], r["emergencyFetched"].as_str().unwrap_or(""));
                }
                None => {
                    let err_before_e = errors.len();
                    let iso_now = crate::wmip::iso_utc((self.now)());
                    let ed = ef(&iso_now, &mut errors);
                    let ed_errs: Vec<String> = errors[err_before_e..].to_vec();
                    let ed_ok = ed["items"].as_array().is_some_and(|a| !a.is_empty()) || ed_errs.is_empty();
                    if ed_ok {
                        r["emergency"] = ed;
                        r["emergencyFetched"] = json!(iso_now.clone());
                    } else if let Some((old, at)) = Self::carry(&prev, "emergency", "emergencyFetched", (self.now)(), 2 * 3_600_000) {
                        r["emergency"] = old;
                        r["emergencyFetched"] = at;
                    }
                    mark_source("emergency", true, ed_ok, &ed_errs, r["emergencyFetched"].as_str().unwrap_or(&iso_now));
                }
            }
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
        r["sources"] = Value::Object(sources.clone());
        r["errors"] = json!(errors.iter().take(20).collect::<Vec<_>>());
        r["attribution"] = json!(format!("© Commonwealth of Australia (Bureau of Meteorology); Queensland live levels {}; {}; {}; {}", feeds::WMIP_ATTRIBUTION, feeds::STORM_TIDE_ATTRIBUTION, feeds::RAIN_ATTRIBUTION, feeds::QLD_TRAFFIC_ATTRIBUTION));
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
        // persist to disk in local mode so the next start is instant
        if let Store::Local(dir) = &self.store {
            let _ = std::fs::create_dir_all(dir);
            let cur = self.current.lock().unwrap_or_else(|e| e.into_inner()).clone();
            if let Some((_, doc)) = cur {
                let _ = std::fs::write(dir.join("readings.json"), doc.body.as_ref());
                if !doc.gz.is_empty() { let _ = std::fs::write(dir.join("readings.json.gz"), doc.gz.as_ref()); }
            }
        }
        let hist = self.update_history(&r["level"], fetched);
        let count = |k: &str| r[k].as_object().map_or(0, |o| o.len());
        Ok(json!({"levels": nl, "storages": ns, "liveQueensland": rt, "rainGauges": count("rain"), "rainObsGauges": count("rainObs"), "seaGauges": count("sea"),
            "roadClosures": r["roads"]["items"].as_array().map(|a| a.len()),
            "watch": r["watch"].as_array().map_or(0, |a| a.len()), "errors": errors.len(), "gzStored": gz_stored, "version": crate::VERSION, "history": hist, "seconds": (fetched - started) / 1000,
            "warnings": r["warnings"]["warnings"].as_array().map(|a| a.len()),
            "floodClasses": r["floodclass"].as_object().map(|o| o.len()),
            "ftpDownloads": ftp_downloads,
            "sources": Value::Object(sources),
            "stageSeconds": {"readings": (t_readings - started) / 1000, "rain": (t_rain - t_readings) / 1000, "sea": (t_sea - t_rain) / 1000, "warnings": (t_warn - t_sea) / 1000}}))
    }

    /// The stored FTP directory index (`{filename: [version, parsed]}`), from
    /// memory or S3 (`readings-ftp-index.json.gz`). Best effort: returns what
    /// this copy has in memory if S3 has none or fails.
    fn load_ftp_index(&self, now: i64) -> std::collections::HashMap<String, (String, Value)> {
        let cur = self.ftp_index.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if !cur.is_empty() {
            return cur;
        }
        let Store::S3(b) = &self.store else { return cur };
        let Ok(crate::s3::Got::Body(z, _)) = b.get(KEY_FTP, None, now) else { return cur };
        let Ok(bytes) = crate::history::gunzip(&z) else { return cur };
        let Ok(Value::Object(m)) = serde_json::from_slice::<Value>(&bytes) else { return cur };
        let mut out = std::collections::HashMap::new();
        for (k, v) in m {
            if let Some(arr) = v.as_array().filter(|a| a.len() == 2) {
                if let Some(ver) = arr[0].as_str() {
                    out.insert(k, (ver.to_string(), arr[1].clone()));
                }
            }
        }
        *self.ftp_index.lock().unwrap_or_else(|e| e.into_inner()) = out.clone();
        out
    }

    fn save_ftp_index(&self, cache: &std::collections::HashMap<String, (String, Value)>, now: i64) {
        *self.ftp_index.lock().unwrap_or_else(|e| e.into_inner()) = cache.clone();
        if let Store::S3(b) = &self.store {
            let mut m = serde_json::Map::new();
            for (k, (ver, val)) in cache {
                m.insert(k.clone(), json!([ver, val]));
            }
            let z = crate::history::gzip(&serde_json::to_vec(&Value::Object(m)).unwrap_or_default());
            if let Err(e) = b.put(KEY_FTP, &z, "application/gzip", now) {
                eprintln!("{} not stored: {}", KEY_FTP, e);
            }
        }
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
            Store::Local(dir) => {
                if let Some((checked, doc)) = &cur {
                    if now - checked < S3_CHECK_MS {
                        return Ok(Some(doc.clone()));
                    }
                }
                // try gz first, then plain
                let gz_path = dir.join("readings.json.gz");
                let plain_path = dir.join("readings.json");
                if let Ok(gz) = std::fs::read(&gz_path) {
                    if let Ok(mut doc) = Doc::from_gz(gz, None, None) {
                        doc.source = "local-gz";
                        let doc = Arc::new(doc);
                        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                        return Ok(Some(doc));
                    }
                }
                if let Ok(body) = std::fs::read(&plain_path) {
                    let fetched_ms = doc_fetched(&body).unwrap_or(now);
                    let mut doc = Doc::new(body, fetched_ms, None);
                    doc.source = "local";
                    let doc = Arc::new(doc);
                    *self.current.lock().unwrap_or_else(|e| e.into_inner()) = Some((now, doc.clone()));
                    return Ok(Some(doc));
                }
                Ok(cur.map(|c| c.1))
            }
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

/// Official flood road closures from QLDTraffic (and Live Traffic NSW when
/// `NSW_TRAFFIC_API_KEY` is set in the environment).
pub fn fetch_roads(iso_now: &str, errors: &mut Vec<String>) -> Value {
    use std::io::Read;
    let get_json = |url: &str, auth: Option<&str>| -> Result<Value, String> {
        let t = Some(std::time::Duration::from_secs(30));
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_connect(t).timeout_recv_response(t).timeout_recv_body(t).http_status_as_error(false).build().into();
        let mut req = agent.get(url).header("User-Agent", "flood-explorer-broker (+https://github.com/ghedwards/flood-explorer)");
        if let Some(a) = auth {
            req = req.header("Authorization", a);
        }
        let mut r = req.call().map_err(|e| e.to_string())?;
        let code = r.status().as_u16();
        let mut b = Vec::new();
        r.body_mut().as_reader().take(8 << 20).read_to_end(&mut b).map_err(|e| e.to_string())?;
        if code >= 400 {
            return Err(format!("HTTP {}", code));
        }
        serde_json::from_slice(&b).map_err(|e| format!("not JSON: {}", e))
    };
    let mut items = Vec::new();
    let mut sources = serde_json::Map::new();
    let qld_key = std::env::var("QLD_TRAFFIC_API_KEY").ok().filter(|k| !k.trim().is_empty()).unwrap_or_else(|| feeds::QLD_TRAFFIC_PUBLIC_KEY.into());
    let nsw_key = std::env::var("NSW_TRAFFIC_API_KEY").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    // Run the per-state fetches sequentially: each body is capped at 2 MB
    // (above) and the refresh already holds ~100 MB, so doing them one at a
    // time keeps the peak under the Lambda's 128 MB. They are independent
    // but 7 x ~2 s is cheap and avoids an OutOfMemory kill.
    let mut jobs: Vec<(&str, String, Option<String>)> = Vec::new();
    jobs.push(("QLD", format!("{}?apikey={}", feeds::QLD_TRAFFIC_URL, feeds::encode(&qld_key)), None));
    if let Some(k) = &nsw_key {
        jobs.push(("NSW", feeds::NSW_TRAFFIC_URL.to_string(), Some(format!("apikey {}", k))));
    }
    jobs.push(("WA", feeds::WA_ROADS_URL.to_string(), None));
    jobs.push(("SA", feeds::SA_ROADS_URL.to_string(), None));
    jobs.push(("NT", feeds::NT_ROADS_URL.to_string(), None));
    jobs.push(("TAS", feeds::TAS_ROADS_URL.to_string(), None));
    jobs.push(("ACT", feeds::ACT_ROADS_URL.to_string(), None));

    for (state, url, auth) in &jobs {
        match get_json(url, auth.as_deref()) {
            Ok(gj) => {
                let parsed = match *state {
                    "QLD" => feeds::parse_qld_roads(&gj),
                    "NSW" => feeds::parse_nsw_roads(&gj),
                    "WA" => feeds::parse_wa_roads(&gj),
                    "SA" => feeds::parse_sa_roads(&gj),
                    "NT" => feeds::parse_nt_roads(&gj),
                    "TAS" => feeds::parse_tas_roads(&gj),
                    "ACT" => feeds::parse_act_roads(&gj),
                    _ => Vec::new(),
                };
                items.extend(parsed);
                sources.insert(state.to_string(), json!("ok"));
            }
            Err(e) => {
                errors.push(format!("roads {}: {}", state, e));
                sources.insert(state.to_string(), json!(format!("error: {}", e)));
            }
        }
    }
    json!({
        "fetched": iso_now,
        "sources": Value::Object(sources),
        "attribution": format!("{}; {}; {}; {}; {}; {}; {}", feeds::QLD_TRAFFIC_ATTRIBUTION, feeds::NSW_TRAFFIC_ATTRIBUTION, feeds::WA_ROADS_ATTRIBUTION, feeds::SA_ROADS_ATTRIBUTION, feeds::NT_ROADS_ATTRIBUTION, feeds::TAS_ROADS_ATTRIBUTION, feeds::ACT_ROADS_ATTRIBUTION),
        "items": items,
    })
}

/// Emergency warnings: NSW RFS major incidents (public, no key) for now.
pub fn fetch_emergency(iso_now: &str, errors: &mut Vec<String>) -> Value {
    use std::io::Read;
    let get_json = |url: &str| -> Result<Value, String> {
        let t = Some(std::time::Duration::from_secs(30));
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_connect(t).timeout_recv_response(t).timeout_recv_body(t).http_status_as_error(false).build().into();
        let mut r = agent.get(url).header("User-Agent", "flood-explorer-broker (+https://github.com/ghedwards/flood-explorer)").call().map_err(|e| e.to_string())?;
        let code = r.status().as_u16();
        let mut b = Vec::new();
        r.body_mut().as_reader().take(8 << 20).read_to_end(&mut b).map_err(|e| e.to_string())?;
        if code >= 400 { return Err(format!("HTTP {}", code)); }
        serde_json::from_slice(&b).map_err(|e| format!("not JSON: {}", e))
    };
    let mut items = Vec::new();
    let mut sources = serde_json::Map::new();
    match get_json(feeds::NSW_RFS_MAJOR_INCIDENTS_URL) {
        Ok(gj) => {
            items.extend(feeds::parse_nsw_rfs_emergency(&gj));
            sources.insert("NSW".into(), json!("ok"));
        }
        Err(e) => {
            errors.push(format!("emergency NSW: {}", e));
            sources.insert("NSW".into(), json!(format!("error: {}", e)));
        }
    }
    json!({
        "fetched": iso_now,
        "sources": Value::Object(sources),
        "attribution": feeds::NSW_RFS_ATTRIBUTION,
        "items": items,
    })
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
        if url == feeds::WARNING_AREAS {
            return Ok(json!({"features": [{"properties": {"dist_name": "Barcoo River"}, "geometry": {"type": "Polygon", "coordinates": [[[144.0, -24.0], [145.0, -24.0], [145.0, -25.0], [144.0, -24.0]]]}}]}));
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
    fn water_data_online_at_most_hourly_live_levels_every_time() {
        use std::sync::atomic::AtomicUsize;
        static KIWIS: AtomicUsize = AtomicUsize::new(0);
        static LIVE: AtomicUsize = AtomicUsize::new(0);
        fn counting(url: &str, ps: &[(String, String)]) -> Result<Value, String> {
            if url.contains("waterdata") { KIWIS.fetch_add(1, Ordering::SeqCst); }
            if url.contains("webservice") || url.contains("water-monitoring") { LIVE.fetch_add(1, Ordering::SeqCst); }
            fake(url, ps)
        }
        let t = Arc::new(AtomicI64::new(crate::wmip::epoch_ms("2026-10-20T08:00:00Z").unwrap()));
        let t2 = t.clone();
        let r = Readings::new(Box::new(counting), Store::Memory, STATIONS_URL.into(), Box::new(move || t2.load(Ordering::SeqCst)));
        r.refresh().unwrap();
        let (k1, l1) = (KIWIS.load(Ordering::SeqCst), LIVE.load(Ordering::SeqCst));
        assert!(k1 > 0 && l1 > 0);
        t.fetch_add(15 * 60_000, Ordering::SeqCst);
        let s = r.refresh().unwrap();
        assert_eq!(KIWIS.load(Ordering::SeqCst), k1, "Water Data Online reused within the hour");
        assert!(LIVE.load(Ordering::SeqCst) > l1, "Queensland's live levels fetched again");
        assert_eq!(s["levels"], 2, "levels carried");
        let v: Value = serde_json::from_slice(&r.latest().unwrap().unwrap().body).unwrap();
        assert_eq!(v["level"]["540198"]["latestKind"], "hourly");
        assert_eq!(v["wdoFetched"], "2026-10-20T08:00:00Z");
        t.fetch_add(50 * 60_000, Ordering::SeqCst);
        r.refresh().unwrap();
        assert!(KIWIS.load(Ordering::SeqCst) > k1, "and asked again after an hour");
    }

    #[test]
    fn qld_traffic_over_quota_is_asked_hourly_not_every_half_hour() {
        use std::sync::atomic::AtomicUsize;
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        let t = Arc::new(AtomicI64::new(crate::wmip::epoch_ms("2026-10-20T08:00:00Z").unwrap()));
        let t2 = t.clone();
        let r = Readings::new(Box::new(fake), Store::Memory, STATIONS_URL.into(), Box::new(move || t2.load(Ordering::SeqCst))).with_roads(Box::new(|iso: &str, errors: &mut Vec<String>| {
            let n = CALLS.fetch_add(1, Ordering::SeqCst);
            if n > 0 {
                errors.push("roads QLD: HTTP 429".into());
                return json!({"fetched": iso, "sources": {"QLD": "error: HTTP 429"}, "items": []});
            }
            json!({"fetched": iso, "sources": {"QLD": "ok"}, "items": []})
        }));
        // the first refresh fetches (no list yet) and records it as good
        r.refresh().unwrap();
        assert_eq!(CALLS.load(Ordering::SeqCst), 1);
        // 40 minutes later: past the half-hour carry, so it is asked again —
        // QLDTraffic is over quota (a 429), which the health now records
        t.fetch_add(40 * 60_000, Ordering::SeqCst);
        r.refresh().unwrap();
        assert_eq!(CALLS.load(Ordering::SeqCst), 2, "a 40-minute-old list is refetched");
        // 10 minutes after the 429: within the expired-quota hour, so the
        // carried list serves the request without touching QLDTraffic
        t.fetch_add(10 * 60_000, Ordering::SeqCst);
        let s = r.refresh().unwrap();
        assert_eq!(CALLS.load(Ordering::SeqCst), 2, "no attempt while the quota hour runs");
        assert_eq!(s["roadClosures"], 0, "the list came from the carry, empty but present");
        // half a quota hour more: asked again (the cadence measures from the
        // stored list's time), still refused; the 2-hour carry keeps the
        // old list on the map
        t.fetch_add(30 * 60_000, Ordering::SeqCst);
        r.refresh().unwrap();
        assert_eq!(CALLS.load(Ordering::SeqCst), 3, "the cadence passed, so it asks again");
        let doc: Value = serde_json::from_slice(&r.latest().unwrap().unwrap().body).unwrap();
        assert_eq!(doc["roads"]["fetched"], "2026-10-20T08:00:00Z", "still the first list: failed attempts don't restamp");
        assert_eq!(doc["sources"]["roads"]["lastError"], "roads QLD: HTTP 429");
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

    #[test]
    fn single_ftp_session_and_per_source_health_across_refreshes() {
        struct MockFtp {
            ver: String,
            gets: Arc< std::sync::atomic::AtomicUsize>,
        }
        impl feeds::ftp::Dir for MockFtp {
            fn list_meta(&mut self, _: &str) -> Result<Vec<(String, String)>, String> {
                Ok(vec![
                    ("IDQ20860.cap.xml".into(), "812 Oct 21 09:00".into()),
                    ("IDQ65301.html".into(), self.ver.clone()),
                ])
            }
            fn get(&mut self, path: &str) -> Result<Vec<u8>, String> {
                self.gets.fetch_add(1, Ordering::SeqCst);
                if path.ends_with(".cap.xml") {
                    Ok(br#"<?xml version="1.0"?><alert><identifier>AusBoM-IDQ20860-2026</identifier><sent>2026-10-20T01:00:00+00:00</sent><info><event>Riverine Flood</event><severity>Minor</severity><expires>2026-10-25T00:00:00+00:00</expires><headline>Minor Flood Warning</headline><description>x</description><area><areaDesc>QLD</areaDesc></area></info></alert>"#.to_vec())
                } else {
                    Ok(br#"<area onmouseover="javascript:PopupRiver(&quot;Brisbane&quot;,'540198','-27.47','153.03','1.80','Minor','rising','20-10-2026 18:00:00','1.70','2.60','3.50','Click')"/>"#.to_vec())
                }
            }
        }
        let gets = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ver = Arc::new(Mutex::new("2048 Oct 20 18:00".to_string()));
        let sea_ok = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let t = Arc::new(AtomicI64::new(crate::wmip::epoch_ms("2026-10-20T08:00:00Z").unwrap()));
        let (t2, g2, v2, s2) = (t.clone(), gets.clone(), ver.clone(), sea_ok.clone());
        let r = Readings::new(Box::new(fake), Store::Memory, STATIONS_URL.into(), Box::new(move || t2.load(Ordering::SeqCst)))
            .with_text(Box::new(move |_| {
                if s2.load(Ordering::SeqCst) {
                    Ok("Site, Seconds, DateTime, Water Level, Prediction, Residual, Latitude, Longitude\nwhyteislandnx,1792530000,2026-10-20T07:00,1.593,1.501,0.092,-27.4017,153.1574\n".into())
                } else {
                    Err("HTTP 503".into())
                }
            }))
            .with_ftp(Box::new(move || Ok(Box::new(MockFtp { ver: v2.lock().unwrap().clone(), gets: g2.clone() }))));

        let s1 = r.refresh().unwrap();
        assert_eq!(s1["ftpDownloads"], 2, "initial refresh downloads CAP + class page");
        assert_eq!(s1["sources"]["wdo"]["lastGood"], "2026-10-20T08:00:00Z");
        assert_eq!(s1["sources"]["wdo"]["errorCount"], 0);
        assert_eq!(s1["sources"]["warnings"]["lastGood"], "2026-10-20T08:00:00Z");
        assert_eq!(s1["sources"]["floodclass"]["lastGood"], "2026-10-20T08:00:00Z");
        assert_eq!(s1["sources"]["sea"]["lastGood"], "2026-10-20T08:00:00Z");

        // 35 minutes later: sea is re-fetched and fails, classes are carried (< 60m),
        // warnings check FTP but CAP file is unchanged -> 0 FTP downloads.
        sea_ok.store(false, Ordering::SeqCst);
        t.fetch_add(35 * 60_000, Ordering::SeqCst);
        let s2 = r.refresh().unwrap();
        assert_eq!(s2["ftpDownloads"], 0, "unchanged CAP file is not downloaded again");
        assert_eq!(gets.load(Ordering::SeqCst), 2);
        assert_eq!(s2["sources"]["sea"]["lastGood"], "2026-10-20T08:00:00Z", "lastGood kept when sea fails");
        assert_eq!(s2["sources"]["sea"]["errorCount"], 1);
        assert!(s2["sources"]["sea"]["lastError"].as_str().unwrap().contains("503"));

        // 30 minutes later (65m total): classes due again, and IDQ65301.html has a new mtime -> 1 download
        *ver.lock().unwrap() = "2055 Oct 20 19:00".into();
        t.fetch_add(30 * 60_000, Ordering::SeqCst);
        let s3 = r.refresh().unwrap();
        assert_eq!(s3["ftpDownloads"], 1, "only the changed river-height page is downloaded");
        assert_eq!(gets.load(Ordering::SeqCst), 3);
    }
}
