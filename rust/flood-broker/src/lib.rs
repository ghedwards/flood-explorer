//! Flood Explorer's live data broker.
//!
//! The map runs in the browser, and the state water portals it wants live
//! river levels from either send no CORS headers or ask not to be hammered.
//! This service sits in between: the browser asks it for the gauges on
//! screen, it asks the portal once for everyone, keeps each answer for a
//! few minutes and replies with CORS headers for the map's own origins.
//!
//!   GET /v1/levels?sites=143001C,130005A   latest hourly levels (Queensland)
//!   GET /health                            status for monitoring
//!
//! [`Broker::handle`] is the whole service minus the socket, so tests drive
//! it with a stand-in portal and clock; `main.rs` puts it on a socket.

pub mod history;
pub mod lambda;
pub mod readings;
pub mod s3;
pub mod wmip;

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const MAX_SITES: usize = 60;
const BATCH: usize = 25;
const STALE_MS: i64 = 6 * 3_600_000; // serve older data while the portal is down
const OPEN_MS: i64 = 24 * 3_600_000; // refresh the open-station list daily
const HOURS: i64 = 30;
const KEEP_POINTS: usize = 30;
const UPSTREAM_AT_ONCE: usize = 2;
const RATE_PER_MIN: f64 = 60.0;
const RATE_BURST: f64 = 30.0;

/// The commit this broker was built from (set by the deploy workflow).
pub const VERSION: &str = match option_env!("FLOOD_BROKER_VERSION") { Some(v) => v, None => "dev" };

pub struct Config {
    pub origins: HashSet<String>,
    pub cache_ms: i64,
    /// how often the readings are refreshed (for browser cache lifetimes)
    pub refresh_ms: i64,
}

impl Default for Config {
    fn default() -> Self {
        Config { origins: ["https://ghedwards.github.io".to_string()].into(), cache_ms: 10 * 60_000, refresh_ms: 15 * 60_000 }
    }
}

pub struct Request<'a> {
    pub method: &'a str,
    /// path and query, e.g. /v1/levels?sites=143001C
    pub target: &'a str,
    pub origin: Option<&'a str>,
    /// the client address used for rate limits
    pub client: &'a str,
    /// the client takes gzip (Accept-Encoding)
    pub gzip: bool,
    /// If-None-Match: the ETag of the copy the client has
    pub if_none_match: Option<&'a str>,
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

struct Entry {
    at: i64,
    pts: Option<Vec<wmip::Point>>,
}

/// Set when a batch has been fetched (whatever the outcome).
type Done = Arc<(Mutex<bool>, Condvar)>;

#[derive(Default)]
struct State {
    cache: HashMap<String, Entry>,
    pending: HashMap<String, Done>,
    open: Option<(i64, Arc<HashSet<String>>)>,
    buckets: HashMap<String, (f64, i64)>,
    active: usize,
    requests: u64,
    upstream_calls: u64,
    upstream_errors: u64,
    last_error: Option<(i64, String)>,
}

pub struct Broker {
    fetch: Box<wmip::FetchJson>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    cfg: Config,
    started: i64,
    st: Mutex<State>,
    slots: Condvar,
    open_lock: Mutex<()>,
    readings: Option<Arc<readings::Readings>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Broker {
    pub fn new(fetch: Box<wmip::FetchJson>, now: Box<dyn Fn() -> i64 + Send + Sync>, cfg: Config) -> Self {
        let started = now();
        Broker { fetch, now, cfg, started, st: Mutex::new(State::default()), slots: Condvar::new(), open_lock: Mutex::new(()), readings: None }
    }

    /// Serve /v1/readings from these readings.
    pub fn with_readings(mut self, r: Arc<readings::Readings>) -> Self {
        self.readings = Some(r);
        self
    }

    /// Fetch every reading again (the schedule's job): a short summary.
    pub fn refresh_readings(&self) -> Value {
        match &self.readings {
            None => json!({"ok": false, "error": "readings are not set up"}),
            Some(r) => match r.refresh() {
                Ok(s) => json!({"ok": true, "summary": s}),
                Err(e) => {
                    let mut st = lock(&self.st);
                    st.upstream_errors += 1;
                    st.last_error = Some(((self.now)(), format!("readings refresh: {}", e)));
                    json!({"ok": false, "error": e})
                }
            },
        }
    }

    /// One portal call, at most UPSTREAM_AT_ONCE at a time.
    fn upstream<T>(&self, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        {
            let mut st = lock(&self.st);
            while st.active >= UPSTREAM_AT_ONCE {
                st = self.slots.wait(st).unwrap_or_else(|e| e.into_inner());
            }
            st.active += 1;
            st.upstream_calls += 1;
        }
        let r = f();
        let mut st = lock(&self.st);
        st.active -= 1;
        if let Err(e) = &r {
            st.upstream_errors += 1;
            st.last_error = Some(((self.now)(), e.clone()));
        }
        drop(st);
        self.slots.notify_one();
        r
    }

    /// The portal's open stations (None: unknown, ask for everything).
    fn open_stations(&self) -> Option<Arc<HashSet<String>>> {
        let fresh = |st: &State, now: i64| st.open.as_ref().filter(|(at, _)| now - at < OPEN_MS).map(|(_, s)| s.clone());
        if let Some(s) = fresh(&lock(&self.st), (self.now)()) {
            return Some(s);
        }
        let _one = lock(&self.open_lock); // one thread refreshes, the rest wait for it
        if let Some(s) = fresh(&lock(&self.st), (self.now)()) {
            return Some(s);
        }
        match self.upstream(|| wmip::open_stations(&*self.fetch)) {
            Ok(set) => {
                let set = Arc::new(set);
                lock(&self.st).open = Some(((self.now)(), set.clone()));
                Some(set)
            }
            // keep the old list if there was one (and try again in an hour)
            Err(_) => {
                let mut st = lock(&self.st);
                let now = (self.now)();
                st.open.as_mut().map(|(at, s)| {
                    *at = (*at).max(now - OPEN_MS + 3_600_000);
                    s.clone()
                })
            }
        }
    }

    /// Make sure every site is cached or being fetched; wait for them.
    /// Returns whether a portal call failed.
    fn fetch_sites(&self, sites: &[String]) -> bool {
        let now = (self.now)();
        let mut mine: Vec<String> = Vec::new();
        let mut waits: Vec<Done> = Vec::new();
        let mut batches: Vec<(Vec<String>, Done)> = Vec::new();
        {
            let mut st = lock(&self.st);
            for s in sites {
                if st.cache.get(s).is_some_and(|e| now - e.at < self.cfg.cache_ms) {
                    continue;
                }
                match st.pending.get(s) {
                    Some(d) => waits.push(d.clone()),
                    None => mine.push(s.clone()),
                }
            }
            for chunk in mine.chunks(BATCH) {
                let d: Done = Arc::new((Mutex::new(false), Condvar::new()));
                for s in chunk {
                    st.pending.insert(s.clone(), d.clone());
                }
                batches.push((chunk.to_vec(), d));
            }
        }
        let mut failed = false;
        for (batch, done) in batches {
            let got = self.upstream(|| wmip::levels(&*self.fetch, &batch, (self.now)(), HOURS));
            let at = (self.now)();
            let mut st = lock(&self.st);
            match got {
                Ok(mut got) => {
                    for s in &batch {
                        let pts = got.remove(s).map(|mut p| {
                            let n = p.len();
                            p.drain(..n.saturating_sub(KEEP_POINTS));
                            p
                        });
                        st.cache.insert(s.clone(), Entry { at, pts });
                    }
                }
                Err(_) => failed = true,
            }
            for s in &batch {
                st.pending.remove(s);
            }
            drop(st);
            *lock(&done.0) = true;
            done.1.notify_all();
        }
        for d in waits {
            let mut ok = lock(&d.0);
            while !*ok {
                let (g, t) = d.1.wait_timeout(ok, Duration::from_secs(60)).unwrap_or_else(|e| e.into_inner());
                ok = g;
                if t.timed_out() {
                    break;
                }
            }
        }
        failed
    }

    fn allowed(&self, client: &str) -> bool {
        let now = (self.now)();
        let mut st = lock(&self.st);
        if st.buckets.len() > 10_000 {
            st.buckets.retain(|_, (_, at)| now - *at < 600_000);
        }
        let b = st.buckets.entry(client.to_string()).or_insert((RATE_BURST, now));
        b.0 = (b.0 + (now - b.1) as f64 / 60_000.0 * RATE_PER_MIN).min(RATE_BURST);
        b.1 = now;
        if b.0 < 1.0 {
            return false;
        }
        b.0 -= 1.0;
        true
    }

    fn reply(&self, req: &Request, status: u16, body: &Value, extra: &[(&str, &str)]) -> Response {
        let mut headers = vec![("Content-Type".to_string(), "application/json; charset=utf-8".to_string()), ("X-Content-Type-Options".to_string(), "nosniff".to_string())];
        if let Some(o) = req.origin.filter(|o| self.cfg.origins.contains(*o) || self.cfg.origins.contains("*")) {
            headers.push(("Access-Control-Allow-Origin".into(), o.to_string()));
        }
        let vary_more = extra.iter().filter(|(k, _)| *k == "Vary").map(|(_, v)| *v).collect::<Vec<_>>();
        headers.push(("Vary".into(), std::iter::once("Origin").chain(vary_more).collect::<Vec<_>>().join(", ")));
        headers.extend(extra.iter().filter(|(k, _)| *k != "Vary").map(|(k, v)| (k.to_string(), v.to_string())));
        let body = if status == 204 || req.method == "HEAD" { Vec::new() } else { body.to_string().into_bytes() };
        Response { status, headers, body }
    }

    fn reply_raw(&self, req: &Request, status: u16, body: Vec<u8>, extra: &[(&str, &str)]) -> Response {
        let mut r = self.reply(req, status, &Value::Null, extra);
        r.body = if req.method == "HEAD" { Vec::new() } else { body };
        r
    }

    fn serve_readings(&self, req: &Request) -> Response {
        let Some(rd) = &self.readings else { return self.reply(req, 404, &json!({"error": "not found"}), &[]) };
        match rd.latest() {
            Ok(Some(doc)) => {
                let now = (self.now)();
                let age = ((now - doc.fetched_ms) / 1000).max(0).to_string();
                // browsers keep it until the next refresh is due (plus the
                // couple of minutes a refresh takes), then ask again
                let period = self.cfg.refresh_ms.max(60_000);
                let due = doc.fetched_ms + period + 180_000;
                let max_age = ((due - now) / 1000).clamp(60, period / 1000);
                let cc = format!("public, max-age={}, stale-while-revalidate=600", max_age);
                let base: [(&str, &str); 3] = [("Cache-Control", &cc), ("ETag", &doc.etag), ("X-Readings-Age", &age)];
                if req.if_none_match.is_some_and(|m| m.split(',').any(|t| t.trim().trim_start_matches("W/") == doc.etag)) {
                    let mut r = self.reply_raw(req, 304, Vec::new(), &base);
                    r.headers.retain(|(k, _)| k != "Content-Type");
                    return r;
                }
                let mut extra = base.to_vec();
                extra.push(("Vary", "Accept-Encoding"));
                if req.gzip && !doc.gz.is_empty() {
                    extra.push(("Content-Encoding", "gzip"));
                    self.reply_raw(req, 200, doc.gz.as_ref().clone(), &extra)
                } else {
                    self.reply_raw(req, 200, doc.body.as_ref().clone(), &extra)
                }
            }
            Ok(None) => self.reply(req, 503, &json!({"error": "readings haven't been fetched yet"}), &[("Retry-After", "60"), ("Cache-Control", "no-store")]),
            Err(e) => self.reply(req, 502, &json!({"error": format!("readings store: {}", e)}), &[("Cache-Control", "no-store")]),
        }
    }

    /// One gauge's hourly levels for the last week: {site, points: [[time, m]]}.
    fn serve_history(&self, req: &Request, query: &str) -> Response {
        let Some(rd) = &self.readings else { return self.reply(req, 404, &json!({"error": "not found"}), &[]) };
        let site = query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == "site").map(|(_, v)| wmip::decode(v).trim().to_string()).unwrap_or_default();
        if site.is_empty() || site.len() > 40 || !site.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
            return self.reply(req, 400, &json!({"error": "site= is required, e.g. ?site=423940A"}), &[]);
        }
        let period = self.cfg.refresh_ms.max(60_000);
        let cc = format!("public, max-age={}, stale-while-revalidate=600", (period / 1000).clamp(60, 900));
        match rd.history_site(&site) {
            Ok(Some(points)) => self.reply(req, 200, &json!({"site": site, "step": "hour", "days": crate::history::KEEP_HOURS / 24, "points": points}), &[("Cache-Control", &cc)]),
            Ok(None) => self.reply(req, 200, &json!({"site": site, "step": "hour", "days": crate::history::KEEP_HOURS / 24, "points": []}), &[("Cache-Control", &cc)]),
            Err(e) => self.reply(req, 502, &json!({"error": format!("history store: {}", e)}), &[("Cache-Control", "no-store")]),
        }
    }

    pub fn handle(&self, req: &Request) -> Response {
        lock(&self.st).requests += 1;
        let (path, query) = req.target.split_once('?').unwrap_or((req.target, ""));
        match req.method {
            "OPTIONS" => return self.reply(req, 204, &Value::Null, &[("Access-Control-Allow-Methods", "GET, HEAD"), ("Access-Control-Max-Age", "86400")]),
            "GET" | "HEAD" => {}
            _ => return self.reply(req, 405, &json!({"error": "GET only"}), &[("Allow", "GET, HEAD, OPTIONS")]),
        }
        if path == "/health" {
            // which readings this copy of the broker serves, and from where
            // (loads them if it hasn't yet: one S3 request)
            let readings = self.readings.as_ref().map(|r| match r.latest() {
                Ok(Some(d)) => json!({"fetched": wmip::iso_utc(d.fetched_ms), "loadedFrom": d.source, "bytes": d.body.len(), "gzBytes": d.gz.len()}),
                Ok(None) => json!({"loadedFrom": null}),
                Err(e) => json!({"error": e}),
            });
            let st = lock(&self.st);
            let body = json!({
                "ok": true, "version": VERSION, "readings": readings, "uptimeS": ((self.now)() - self.started) / 1000, "cachedSites": st.cache.len(),
                "openStations": st.open.as_ref().map(|(_, s)| s.len()),
                "requests": st.requests, "upstreamCalls": st.upstream_calls, "upstreamErrors": st.upstream_errors,
                "lastError": st.last_error.as_ref().map(|(at, m)| json!({"at": wmip::iso_utc(*at), "message": m})),
            });
            drop(st);
            return self.reply(req, 200, &body, &[("Cache-Control", "no-store")]);
        }
        if path != "/v1/levels" && path != "/v1/readings" && path != "/v1/history" {
            return self.reply(req, 404, &json!({"error": "not found"}), &[]);
        }
        if !self.allowed(req.client) {
            return self.reply(req, 429, &json!({"error": "too many requests"}), &[("Retry-After", "30")]);
        }
        if path == "/v1/readings" {
            return self.serve_readings(req);
        }
        if path == "/v1/history" {
            return self.serve_history(req, query);
        }
        let raw = query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == "sites").map(|(_, v)| wmip::decode(v)).unwrap_or_default();
        let mut ids: Vec<String> = Vec::new();
        for s in raw.split(',').map(|s| s.trim().to_ascii_uppercase()).filter(|s| !s.is_empty()) {
            if !ids.contains(&s) {
                ids.push(s);
            }
        }
        if ids.is_empty() {
            return self.reply(req, 400, &json!({"error": "sites= is required, e.g. ?sites=143001C"}), &[]);
        }
        if ids.len() > MAX_SITES {
            return self.reply(req, 400, &json!({"error": format!("at most {} sites at a time", MAX_SITES)}), &[]);
        }
        let (good, mut missing): (Vec<String>, Vec<String>) = ids.into_iter().partition(|s| wmip::is_site(s));
        let open = if good.is_empty() { None } else { self.open_stations() };
        let wanted: Vec<String> = match &open {
            Some(set) => {
                let (w, not): (Vec<String>, Vec<String>) = good.into_iter().partition(|s| set.contains(s));
                missing.extend(not);
                w
            }
            None => good,
        };
        let failed = !wanted.is_empty() && self.fetch_sites(&wanted);
        let now = (self.now)();
        let mut sites = Map::new();
        let mut stale = false;
        {
            let st = lock(&self.st);
            for s in wanted {
                match st.cache.get(&s) {
                    Some(Entry { at, pts: Some(p) }) if now - at <= STALE_MS && !p.is_empty() => {
                        stale |= now - at >= self.cfg.cache_ms;
                        let series: Vec<Value> = p.iter().map(|(t, v)| json!([t, v])).collect();
                        sites.insert(s, json!({"latest": series[series.len() - 1], "series": series, "checked": wmip::iso_utc(*at)}));
                    }
                    _ => missing.push(s),
                }
            }
        }
        let empty = sites.is_empty();
        let mut body = json!({
            "source": "Queensland Water Monitoring Information Portal", "attribution": wmip::ATTRIBUTION,
            "kind": "hourly mean river level, metres on the gauge datum",
            "at": wmip::iso_utc(now), "sites": Value::Object(sites), "missing": missing,
        });
        if stale {
            body["stale"] = json!(true);
        }
        if failed && empty {
            body["error"] = json!("the Queensland portal did not answer");
            return self.reply(req, 502, &body, &[("Cache-Control", "no-store")]);
        }
        let cc = if stale || failed { "no-store" } else { "public, max-age=300" };
        self.reply(req, 200, &body, &[("Cache-Control", cc)])
    }
}

/// A JSON GET with a budget (seconds) per phase.
pub fn fetch_with_timeout(url: &str, secs: u64) -> Result<Value, String> {
    use std::io::Read;
    let t = Some(Duration::from_secs(secs));
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(secs.min(30))))
        .timeout_send_request(t)
        .timeout_recv_response(t)
        .timeout_recv_body(t)
        .http_status_as_error(false)
        .build()
        .into();
    let mut r = agent
        .get(url)
        .header("User-Agent", "flood-explorer-broker (+https://github.com/ghedwards/flood-explorer)")
        .call()
        .map_err(|e| e.to_string())?;
    let code = r.status().as_u16();
    let mut body = Vec::new();
    r.body_mut().as_reader().take(64 << 20).read_to_end(&mut body).map_err(|e| e.to_string())?;
    if code >= 400 {
        return Err(format!("HTTP {}", code));
    }
    serde_json::from_slice(&body).map_err(|e| format!("not JSON: {}", e))
}

/// Can the broker reach the Bureau pages the site build is blocked from?
/// Each URL with our own User-Agent and a browser's: status, size, start.
/// Reachability of the sources the broker relies on, as the broker
/// (its own User-Agent only: nothing here poses as a browser). Extra URLs to
/// check (a new feed, before writing a parser) come from PROBE_URLS,
/// comma-separated; the first 2 KB of each answer are returned.
pub fn probe() -> Value {
    use std::io::Read;
    let mut urls: Vec<String> = vec![
        "https://www.bom.gov.au/waterdata/services?service=kisters&type=QueryServices&format=json&request=getrequestinfo".into(),
        format!("{}?where=1%3D1&returnCountOnly=true&f=json", flood_feeds::WARNING_AREAS),
    ];
    urls.extend(std::env::var("PROBE_URLS").unwrap_or_default().split(',').map(str::trim).filter(|u| u.starts_with("https://")).map(String::from));
    let t = Some(Duration::from_secs(20));
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_connect(t).timeout_recv_response(t).timeout_recv_body(t).http_status_as_error(false).build().into();
    let mut out = Vec::new();
    for url in urls.iter().take(10) {
        let r = agent.get(url).header("User-Agent", "flood-explorer-broker (+https://github.com/ghedwards/flood-explorer)").call();
        out.push(match r {
            Ok(mut r) => {
                let code = r.status().as_u16();
                let mut b = Vec::new();
                let _ = r.body_mut().as_reader().take(2048).read_to_end(&mut b);
                json!({"url": url, "status": code, "start": String::from_utf8_lossy(&b).chars().filter(|c| !c.is_control()).collect::<String>()})
            }
            Err(e) => json!({"url": url, "error": e.to_string()}),
        });
    }
    // and the FTP server the warnings, classes and levels come from
    out.push(match flood_feeds::ftp::Session::open(flood_feeds::BOM_FTP_HOST, 20).and_then(|mut s| s.list(flood_feeds::BOM_FTP_DIR)) {
        Ok(names) => json!({"ftp": flood_feeds::BOM_FTP_DIR, "files": names.len(), "cap": names.iter().filter(|n| n.ends_with(".cap.xml")).count()}),
        Err(e) => json!({"ftp": flood_feeds::BOM_FTP_DIR, "error": e}),
    });
    json!({"probe": out})
}

/// The real portal call for /v1/levels: 20 seconds per phase.
pub fn http_fetch(url: &str) -> Result<Value, String> {
    fetch_with_timeout(url, 20)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    struct Portal {
        calls: Mutex<Vec<Value>>,
        down: std::sync::atomic::AtomicBool,
        delay_ms: u64,
    }

    impl Portal {
        fn answer(&self, url: &str) -> Result<Value, String> {
            let q: Value = serde_json::from_str(&wmip::decode(url.split_once('?').unwrap().1)).unwrap();
            lock(&self.calls).push(q.clone());
            if self.delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(self.delay_ms));
            }
            if self.down.load(Ordering::SeqCst) {
                return Err("HTTP 503".into());
            }
            if q["function"] == "get_site_list" {
                return Ok(json!({"error_num": 0, "return": {"sites": ["143001C", "130005A", "422201F"]}}));
            }
            let traces: Vec<Value> = q["params"]["site_list"].as_str().unwrap().split(',').filter(|s| *s != "422201F").map(|s| json!({"site": s, "trace": [
                {"v": "2.100", "t": 20261020160000u64, "q": 130}, {"v": "2.250", "t": 20261020170000u64, "q": 130}, {"v": "9.9", "t": 20261020180000u64, "q": 255}]})).collect();
            Ok(json!({"error_num": 0, "return": {"traces": traces}}))
        }
        fn count(&self, f: &str) -> usize {
            lock(&self.calls).iter().filter(|q| q["function"] == f).count()
        }
    }

    fn setup(delay_ms: u64) -> (Arc<Portal>, Arc<AtomicI64>, Arc<Broker>) {
        let p = Arc::new(Portal { calls: Mutex::new(Vec::new()), down: false.into(), delay_ms });
        let t = Arc::new(AtomicI64::new(wmip::epoch_ms("2026-10-20T08:00:00Z").unwrap()));
        let (p2, t2) = (p.clone(), t.clone());
        let b = Broker::new(Box::new(move |u| p2.answer(u)), Box::new(move || t2.load(Ordering::SeqCst)), Config::default());
        (p, t, Arc::new(b))
    }

    fn get(b: &Broker, target: &str, origin: Option<&str>) -> (u16, Value, Vec<(String, String)>) {
        let r = b.handle(&Request { method: "GET", target, origin, client: "1.2.3.4", gzip: false, if_none_match: None });
        let v = if r.body.is_empty() { Value::Null } else { serde_json::from_slice(&r.body).unwrap() };
        (r.status, v, r.headers)
    }

    fn header<'a>(h: &'a [(String, String)], k: &str) -> Option<&'a str> {
        h.iter().find(|(a, _)| a.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }

    #[test]
    fn levels_cached_for_everyone_with_cors_for_the_map_only() {
        let (p, t, b) = setup(0);
        let (s, v, h) = get(&b, "/v1/levels?sites=143001C,130005a,999999X,bogus", Some("https://ghedwards.github.io"));
        assert_eq!(s, 200);
        assert_eq!(v["sites"]["143001C"]["latest"], json!(["2026-10-20T17:00:00+10:00", 2.25]), "quality 255 dropped");
        assert!(v["sites"].get("130005A").is_some(), "ids upper-cased");
        let mut missing: Vec<&str> = v["missing"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        missing.sort();
        assert_eq!(missing, ["999999X", "BOGUS"]);
        assert_eq!(header(&h, "access-control-allow-origin"), Some("https://ghedwards.github.io"));
        assert!(v["attribution"].as_str().unwrap().contains("State of Queensland"));
        assert_eq!(p.count("get_ts_traces"), 1);
        assert_eq!(lock(&p.calls).iter().find(|q| q["function"] == "get_ts_traces").unwrap()["params"]["site_list"], "143001C,130005A");

        let (s, _, h) = get(&b, "/v1/levels?sites=143001C", Some("https://evil.example"));
        assert_eq!(s, 200);
        assert_eq!(header(&h, "access-control-allow-origin"), None);
        assert_eq!(p.count("get_ts_traces"), 1, "served from the cache");

        t.fetch_add(11 * 60_000, Ordering::SeqCst);
        get(&b, "/v1/levels?sites=143001C", None);
        assert_eq!(p.count("get_ts_traces"), 2, "asked again after the cache time");
        assert_eq!(p.count("get_site_list"), 1, "station list kept for a day");

        let (_, v, _) = get(&b, "/v1/levels?sites=422201F", None);
        assert_eq!(v["missing"], json!(["422201F"]), "open station with no readings");

        assert_eq!(get(&b, "/v1/levels", None).0, 400);
        let many: Vec<String> = (0..61).map(|i| format!("{}A", 100000 + i)).collect();
        assert_eq!(get(&b, &format!("/v1/levels?sites={}", many.join(",")), None).0, 400);
        assert_eq!(get(&b, "/nope", None).0, 404);
        let r = b.handle(&Request { method: "POST", target: "/v1/levels", origin: None, client: "x", gzip: false, if_none_match: None });
        assert_eq!(r.status, 405);
        let (_, v, _) = get(&b, "/health", None);
        assert_eq!(v["ok"], true);
        assert_eq!(v["openStations"], 3);
    }

    #[test]
    fn portal_down_serves_older_readings_for_a_while_then_502() {
        let (p, t, b) = setup(0);
        get(&b, "/v1/levels?sites=143001C", None);
        p.down.store(true, Ordering::SeqCst);
        t.fetch_add(30 * 60_000, Ordering::SeqCst);
        let (s, v, h) = get(&b, "/v1/levels?sites=143001C", None);
        assert_eq!(s, 200);
        assert_eq!(v["stale"], true);
        assert_eq!(header(&h, "cache-control"), Some("no-store"));
        t.fetch_add(7 * 3_600_000, Ordering::SeqCst);
        let (s, v, _) = get(&b, "/v1/levels?sites=143001C", None);
        assert_eq!(s, 502, "{}", v);
        let (_, v, _) = get(&b, "/health", None);
        assert!(v["upstreamErrors"].as_u64().unwrap() >= 2);
        assert!(v["lastError"]["message"].as_str().unwrap().contains("503"));
    }

    #[test]
    fn many_viewers_at_once_make_one_portal_call() {
        let (p, _, b) = setup(40);
        let ok = Arc::new(AtomicUsize::new(0));
        let hs: Vec<_> = (0..10)
            .map(|i| {
                let (b, ok) = (b.clone(), ok.clone());
                std::thread::spawn(move || {
                    let client = format!("10.0.0.{}", i);
                    let r = b.handle(&Request { method: "GET", target: "/v1/levels?sites=143001C,130005A", origin: None, client: &client, gzip: false, if_none_match: None });
                    let v: Value = serde_json::from_slice(&r.body).unwrap();
                    if r.status == 200 && v["sites"].get("143001C").is_some() {
                        ok.fetch_add(1, Ordering::SeqCst);
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        assert_eq!(ok.load(Ordering::SeqCst), 10);
        assert_eq!(p.count("get_ts_traces"), 1);
        assert_eq!(p.count("get_site_list"), 1);
    }

    #[test]
    fn readings_route() {
        let (_, _, b) = setup(0);
        assert_eq!(get(&b, "/v1/readings", None).0, 404, "not set up");
        let (_, _, b) = setup(0);
        let b = Arc::try_unwrap(b).ok().unwrap();
        let http = |u: &str, _: &[(String, String)]| -> Result<Value, String> {
            if u.contains("stations") { Ok(json!({"level": ["540198"], "storage": []})) } else if u.contains("webservice") { Ok(json!({"error_num": 0, "return": {"sites": []}})) } else { Err("down".into()) }
        };
        let rd = Arc::new(readings::Readings::new(Box::new(http), readings::Store::Memory, "https://x/stations.json".into(), Box::new(|| 1_800_000_000_000)));
        let b = b.with_readings(rd);
        let (s, v, _) = get(&b, "/v1/readings", Some("https://ghedwards.github.io"));
        assert_eq!(s, 503, "{}", v);
        let r = b.refresh_readings();
        assert_eq!(r["ok"], false, "nothing fetched is an error");
        let (_, v, _) = get(&b, "/health", None);
        assert!(v["lastError"]["message"].as_str().unwrap().contains("readings refresh"));
    }

    #[test]
    fn readings_are_gzipped_revalidated_and_kept_until_the_next_refresh() {
        use std::io::Read;
        let (_, t, b) = setup(0);
        let b = Arc::try_unwrap(b).ok().unwrap();
        let http = |u: &str, p: &[(String, String)]| -> Result<Value, String> {
            if u.contains("stations") { return Ok(json!({"level": ["540198"], "storage": []})); }
            if u.contains("webservice") { return Ok(json!({"error_num": 0, "return": {"sites": []}})); }
            let req = p.iter().find(|x| x.0 == "request").map(|x| x.1.as_str());
            Ok(if req == Some("getTimeseriesList") { json!([["station_no", "ts_id"], ["540198", "1"]]) } else { json!([{"ts_id": "1", "data": [["2026-10-20T00:00:00.000+10:00", 1.5]]}]) })
        };
        let t2 = t.clone();
        let rd = Arc::new(readings::Readings::new(Box::new(http), readings::Store::Memory, "https://x/stations.json".into(), Box::new(move || t2.load(std::sync::atomic::Ordering::SeqCst))));
        let b = b.with_readings(rd);
        assert_eq!(b.refresh_readings()["ok"], true);
        let hist = |t: &str| b.handle(&Request { method: "GET", target: t, origin: Some("https://ghedwards.github.io"), client: "9.9.9.8", gzip: false, if_none_match: None });
        let hv: Value = serde_json::from_slice(&hist("/v1/history?site=540198").body).unwrap();
        assert_eq!(hv["site"], "540198");
        assert_eq!(hv["points"][0][1], 1.5, "the hourly record serves one gauge");
        assert_eq!(hist("/v1/history").status, 400);
        assert_eq!(hist("/v1/history?site=../x").status, 400);
        let get = |gzip: bool, inm: Option<&str>| b.handle(&Request { method: "GET", target: "/v1/readings", origin: Some("https://ghedwards.github.io"), client: "9.9.9.9", gzip, if_none_match: inm });
        let plain = get(false, None);
        let zipped = get(true, None);
        let h = |r: &Response, k: &str| r.headers.iter().find(|(a, _)| a.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone());
        assert_eq!(h(&zipped, "content-encoding").as_deref(), Some("gzip"));
        assert!(zipped.body.len() < plain.body.len());
        let mut un = Vec::new();
        flate2::read::GzDecoder::new(&zipped.body[..]).read_to_end(&mut un).unwrap();
        assert_eq!(un, plain.body, "gzip round-trips");
        assert_eq!(h(&zipped, "vary").as_deref(), Some("Origin, Accept-Encoding"));
        let etag = h(&plain, "etag").unwrap();
        let cc = h(&plain, "cache-control").unwrap();
        assert!(cc.starts_with("public, max-age=900"), "fresh: until the next refresh, capped at the period: {}", cc);
        let again = get(true, Some(&etag));
        assert_eq!(again.status, 304);
        assert!(again.body.is_empty());
        assert_eq!(get(true, Some("\"other\"")).status, 200);
        t.fetch_add(14 * 60_000, std::sync::atomic::Ordering::SeqCst);
        let later = get(false, None);
        assert!(h(&later, "cache-control").unwrap().starts_with("public, max-age=240"), "{:?}", h(&later, "cache-control"));
    }

    #[test]
    fn rate_limited_per_client() {
        let (_, _, b) = setup(0);
        let codes: Vec<u16> = (0..40).map(|_| get(&b, "/v1/levels?sites=143001C", None).0).collect();
        assert!(codes[..30].iter().all(|c| *c == 200));
        assert!(codes[30..].iter().all(|c| *c == 429));
    }
}
