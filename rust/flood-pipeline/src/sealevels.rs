//! Recorded hourly sea levels for the recorded floods near the coast (was
//! pipeline/fetch_sealevels.py).
//!
//! Usage: flood sealevels <events.json> <sea.json>
//!        flood sealevels merge <events.json> <sea.json> <out.json>
//!
//! For each recorded flood, the nearest UHSLC tide gauge within 150 km
//! (hourly research-quality data, else fast-delivery, from one of several
//! ERDDAP servers), or a nearer Maritime Safety Queensland gauge (archived
//! 10-minute readings on the Queensland open data portal), as metres above
//! the gauge's mean for the year. Writes {event id: {station, km, source,
//! series: [[hours from the flood's start, metres], ...]}}; `merge` adds
//! them to the events file the app reads.

use crate::net;
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};

/// (name, UHSLC id, lat, lon)
const STATIONS: [(&str, i64, f64, f64); 14] = [
    ("Spring Bay", 335, -42.55, 147.933), ("Portland", 129, -38.343, 141.613), ("Esperance", 176, -33.867, 121.9),
    ("Fort Denison (Sydney)", 333, -33.85, 151.233), ("Thevenard", 128, -32.15, 133.64), ("Fremantle", 175, -32.05, 115.733),
    ("Brisbane", 331, -27.367, 153.167), ("Bundaberg", 332, -24.833, 152.35), ("Carnarvon", 167, -24.883, 113.617),
    ("Port Hedland", 169, -20.317, 118.567), ("Townsville", 334, -19.25, 146.833), ("Broome", 166, -18.0, 122.217),
    ("Darwin", 168, -12.467, 130.85), ("Booby Island", 336, -10.6, 141.917),
];
const SOURCES: [(&str, &str); 5] = [
    ("https://uhslc.soest.hawaii.edu/erddap", "global_hourly_rqds"),
    ("https://pae-paha.pacioos.hawaii.edu/erddap", "uhslc_global_hourly_rqds"),
    ("https://osmc.noaa.gov/erddap", "global_hourly_rqds"),
    ("https://uhslc.soest.hawaii.edu/erddap", "global_hourly_fast"),
    ("https://erddap.emodnet-physics.eu/erddap", "UHSLC_global_hourly_fast"),
];
const MAX_KM: f64 = 150.0;
const MSQ_SITES: [(&str, f64, f64); 19] = [
    ("Southport", -27.96, 153.42), ("Brisbane Bar", -27.37, 153.17), ("Mooloolaba", -26.68, 153.13),
    ("Urangan", -25.30, 152.91), ("Bundaberg", -24.76, 152.40), ("Gladstone", -23.83, 151.25),
    ("Port Alma", -23.58, 150.86), ("Rosslyn Bay", -23.16, 150.79), ("Mackay", -21.10, 149.23),
    ("Shute Harbour", -20.29, 148.79), ("Bowen", -20.02, 148.25), ("Townsville", -19.25, 146.83),
    ("Cardwell", -18.27, 146.03), ("Clump Point", -17.85, 146.12), ("Mourilyan Harbour", -17.60, 146.12),
    ("Cairns", -16.92, 145.78), ("Cooktown", -15.46, 145.25), ("Weipa", -12.67, 141.86), ("Karumba", -17.49, 140.83),
];
const QLD_CKAN: &str = "https://www.data.qld.gov.au/api/3/action/package_search";
const AEST: i64 = 10;
const H: f64 = 3600.0;

/// Readings: (UTC seconds, metres)
pub type Rows = Vec<(f64, f64)>;
/// (server, dataset, UHSLC id, from, to) -> readings
pub type Fetch<'a> = &'a dyn Fn(&str, &str, i64, f64, f64) -> R<Rows>;
/// (site, year) -> readings
pub type Msq<'a> = &'a dyn Fn(&str, i64) -> R<Rows>;

pub fn nearest(lat: f64, lon: f64) -> (Option<(&'static str, i64, f64, f64)>, f64) {
    let mut best = STATIONS[0];
    for s in STATIONS {
        if km(lat, lon, s.2, s.3) < km(lat, lon, best.2, best.3) {
            best = s;
        }
    }
    let d = km(lat, lon, best.2, best.3);
    (if d <= MAX_KM { Some(best) } else { None }, d)
}

fn utc_stamp(t: f64) -> String {
    let s = iso(t, 0);
    format!("{}Z", &s[..19])
}

/// Readings from an ERDDAP tabledap CSV query.
pub fn erddap(server: &str, ds: &str, sid: i64, t0: f64, t1: f64) -> R<Rows> {
    let q = format!("{}/tabledap/{}.csv?time,sea_level&uhslc_id={}&time>={}&time<={}", server, ds, sid, utc_stamp(t0), utc_stamp(t1));
    let url = net::quote(&q, ":/?&=,>");
    let text = net::get(&url, &[], 120).map_err(|e| e.to_string())?.text();
    let mut out = Vec::new();
    for row in csv_rows(&text).into_iter().skip(2) {
        let (Some(t), Some(v)) = (row.first().and_then(|t| parse_iso(t, 0)), row.get(1).and_then(|v| v.trim().parse::<f64>().ok())) else { continue };
        if v.is_finite() && v.abs() < 30000.0 {
            out.push((t, v / 1000.0));
        }
    }
    Ok(out)
}

/// Readings from an MSQ file, whatever its layout: each line with a
/// date-time (AEST) and a level.
pub fn parse_levels(text: &str) -> Rows {
    let pats = [
        (Regex::new(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})").unwrap(), true),
        (Regex::new(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})").unwrap(), false),
        (Regex::new(r"^\s*(\d{2})(\d{2})((?:19|20)\d{2})(\d{2})(\d{2})\b").unwrap(), false),
        (Regex::new(r"\b((?:19|20)\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\b").unwrap(), true),
    ];
    let split = Regex::new(r"[,\s;]+").unwrap();
    let mut out = Vec::new();
    for line in text.lines() {
        for (pat, ymd) in &pats {
            let Some(m) = pat.captures(line) else { continue };
            let g: Vec<i64> = (1..=5).map(|i| m[i].parse().unwrap()).collect();
            let (y, mo, d) = if *ymd { (g[0], g[1], g[2]) } else { (g[2], g[1], g[0]) };
            if !valid_date(y, mo, d) || g[4] > 59 {
                break;
            }
            let t = days_from_civil(y, mo, d) as f64 * 86400.0 + ((g[3] % 24) * 3600 + g[4] * 60) as f64 - (AEST * 3600) as f64;
            let rest = &line[m.get(0).unwrap().end()..];
            for tok in split.split(rest) {
                let Ok(v) = tok.parse::<f64>() else { continue };
                if v > -3.0 && v < 12.0 && v != -99.0 {
                    out.push((t, v));
                }
                break;
            }
            break;
        }
    }
    out
}

/// Maritime Safety Queensland archived readings, read once per site and
/// year, within a time budget.
pub struct MsqSource {
    catalogue: RefCell<Option<HashMap<String, Vec<Value>>>>,
    years: RefCell<HashMap<(String, i64), Rows>>,
    until: RefCell<Option<f64>>,
}

impl MsqSource {
    pub fn new() -> Self {
        MsqSource { catalogue: RefCell::new(None), years: RefCell::new(HashMap::new()), until: RefCell::new(None) }
    }
}

impl Default for MsqSource {
    fn default() -> Self { Self::new() }
}

impl MsqSource {
    fn catalogue(&self) -> R<HashMap<String, Vec<Value>>> {
        if let Some(c) = self.catalogue.borrow().as_ref() {
            return Ok(c.clone());
        }
        let url = net::with_query(QLD_CKAN, &[("q", "tide gauge archived interval recordings"), ("rows", "100")]);
        let res = net::get_json(&url, &[], 120)?;
        let split = Regex::new(r"(?i)\s+tide gauge").unwrap();
        let mut c = HashMap::new();
        for pkg in arr(res.get("result").and_then(|r| r.get("results"))) {
            let title = s_or_empty(pkg.get("title"));
            if !title.to_lowercase().contains("archived") {
                continue;
            }
            let site = split.split(&title).next().unwrap_or("").trim().to_lowercase();
            c.insert(site, arr(pkg.get("resources")).to_vec());
        }
        *self.catalogue.borrow_mut() = Some(c.clone());
        Ok(c)
    }

    pub fn year(&self, site: &str, year: i64) -> R<Rows> {
        let key = (site.to_lowercase(), year);
        if let Some(r) = self.years.borrow().get(&key) {
            return Ok(r.clone());
        }
        let now = now_s();
        let until = *self.until.borrow_mut().get_or_insert(now + 480.0);
        if now > until {
            return Err("time budget for Queensland files used up".into());
        }
        let rows = self.fetch_year(site, year)?;
        self.years.borrow_mut().insert(key, rows.clone());
        Ok(rows)
    }

    fn fetch_year(&self, site: &str, year: i64) -> R<Rows> {
        let cat = self.catalogue()?;
        let resources = cat.get(&site.to_lowercase()).cloned().unwrap_or_default();
        if resources.is_empty() {
            let names: Vec<&String> = cat.keys().take(6).collect();
            return Err(format!("no dataset named for {} among {} ({})", site, cat.len(), names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
        }
        let ys = year.to_string();
        let pick: Vec<&Value> = resources
            .iter()
            .filter(|r| format!("{} {}", s_or_empty(r.get("name")), s_or_empty(r.get("url"))).contains(&ys))
            .filter(|r| ["csv", "txt", "zip", ""].contains(&s_or_empty(r.get("format")).to_lowercase().as_str()))
            .collect();
        if pick.is_empty() {
            let names: Vec<String> = resources.iter().take(4).map(|r| format!("{} [{}]", s_or_empty(r.get("name")), s_or_empty(r.get("format")))).collect();
            return Err(format!("no {} file among {} ({})", year, resources.len(), names.join("; ")));
        }
        if let Some(r) = pick.into_iter().next() {
            let url = s_or_empty(r.get("url"));
            let (mut body, mut ctype) = (Vec::new(), String::new());
            for attempt in 0..3u64 {
                // the portal sometimes answers empty: wait and retry
                let resp = net::get(&url, &[], 120).map_err(|e| e.to_string())?;
                body = resp.body;
                ctype = resp.content_type;
                if !body.is_empty() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_secs(10 * (attempt + 1)));
            }
            if body.starts_with(b"PK") {
                body = unzip(&body)?.into_iter().map(|(_, b)| b).collect::<Vec<_>>().join(&b'\n');
            }
            let text = String::from_utf8_lossy(&body).into_owned();
            let rows = parse_levels(&text);
            if rows.len() > 1000 {
                return Ok(rows);
            }
            let first: Vec<&str> = text.lines().take(6).filter(|l| !l.trim().is_empty()).collect();
            return Err(format!("{} readings parsed from {} ({} bytes, {}, {}; starts: {})", rows.len(), s_or_empty(r.get("name")), body.len(), ctype, tail(&url, 60), clip(&first.join(" | "), 300)));
        }
        Ok(Vec::new())
    }
}

fn year_of(t: f64, off_h: i64) -> i64 {
    civil_from_days(((t + (off_h * 3600) as f64) / 86400.0).floor() as i64).0
}

/// Hourly series relative to the year's mean over the flood's dates.
fn from_readings(year_rows: &Rows, start: f64, end: f64) -> Option<Vec<Value>> {
    if year_rows.len() < 24 * 60 {
        return None;
    }
    let mean = year_rows.iter().map(|r| r.1).sum::<f64>() / year_rows.len() as f64;
    let mut bins: BTreeMap<i64, Vec<f64>> = BTreeMap::new();
    for &(t, v) in year_rows {
        if start - H <= t && t <= end {
            bins.entry(((t - start) / H).floor() as i64).or_default().push(v - mean);
        }
    }
    let series: Vec<Value> = bins.into_iter().map(|(h, vs)| json!([h, num(round_to(vs.iter().sum::<f64>() / vs.len() as f64, 3))])).collect();
    if series.len() >= 12 { Some(series) } else { None }
}

fn msq_for(lat: f64, lon: f64, start: f64, end: f64, off: i64, msq: Msq) -> (Option<Value>, f64, Option<String>) {
    let mut site = MSQ_SITES[0];
    for s in MSQ_SITES {
        if km(lat, lon, s.1, s.2) < km(lat, lon, site.1, site.2) {
            site = s;
        }
    }
    let d = km(lat, lon, site.1, site.2);
    if d > MAX_KM {
        return (None, d, None);
    }
    let rows = (|| -> R<Rows> {
        let mut rows = msq(site.0, year_of(start, off))?;
        if year_of(end, off) != year_of(start, off) {
            rows.extend(msq(site.0, year_of(end, off))?);
        }
        Ok(rows)
    })();
    let rows = match rows {
        Ok(r) => r,
        Err(e) => return (None, d, Some(format!("MSQ {}: {}", site.0, clip(&e, 400)))),
    };
    match from_readings(&rows, start, end) {
        Some(series) => (
            Some(obj! {"station" => format!("{} (Maritime Safety Queensland)", site.0), "km" => num(round_to(d, 1)),
                "source" => "Maritime Safety Queensland archived tide gauge readings", "series" => series}),
            d,
            None,
        ),
        None => (None, d, Some(format!("MSQ {}: no readings for those dates", site.0))),
    }
}

pub fn sea_for(ev: &Value, fetch: Fetch, msq: Msq) -> R<(Option<Value>, Option<String>)> {
    let (lat, lon) = (get_f64(ev, "lat").ok_or("no lat")?, get_f64(ev, "lon").ok_or("no lon")?);
    let (st, d) = nearest(lat, lon);
    let start_s = get_str(ev, "start").ok_or("no start")?;
    let start = parse_iso(start_s, AEST).ok_or("bad start")?;
    let off = iso_offset_h(start_s, AEST);
    let last_h = arr(ev.get("series")).iter().filter_map(|r| r[0].as_f64()).fold(f64::NEG_INFINITY, f64::max);
    let end = start + (last_h + 24.0) * H;
    let qld = lon > 137.9 && lat > -29.2;
    let near_msq = MSQ_SITES.iter().map(|s| km(lat, lon, s.1, s.2)).fold(f64::INFINITY, f64::min);
    let want_q = qld && (st.is_none() || near_msq < d - 40.0);
    let (q, dq, why_q) = if want_q { msq_for(lat, lon, start, end, off, msq) } else { (None, f64::INFINITY, None) };
    if let Some(w) = &why_q {
        println!("note: {}: {}", s_or_empty(ev.get("id")), w);
    }
    if q.is_some() && (st.is_none() || dq <= d) {
        return Ok((q, None));
    }
    let Some(st) = st else {
        return Ok(if q.is_some() {
            (q, None)
        } else {
            (None, Some(format!("no tide gauge within {} km ({:.0} km){}", MAX_KM as i64, d, why_q.map(|w| format!("; {}", w)).unwrap_or_default())))
        });
    };
    let y = year_of(start, off);
    let year0 = days_from_civil(y, 1, 1) as f64 * 86400.0;
    let year1 = days_from_civil(y + 1, 1, 1) as f64 * 86400.0;
    let mut why: Vec<String> = why_q.into_iter().collect();
    for (server, ds) in SOURCES {
        let attempt = (|| -> R<Option<Value>> {
            let year = fetch(server, ds, st.1, year0, year1)?;
            if year.len() < 24 * 60 {
                why.push(format!("{}: {} readings that year", ds, year.len()));
                return Ok(None);
            }
            let mean = year.iter().map(|r| r.1).sum::<f64>() / year.len() as f64;
            let mut win: Rows = year.iter().copied().filter(|&(t, _)| start - H <= t && t <= end).collect();
            if win.len() < 12 {
                // the flood runs into the next year: read the window itself
                win = fetch(server, ds, st.1, start, end)?;
            }
            let mut by_h: BTreeMap<i64, f64> = BTreeMap::new();
            for (t, v) in win {
                by_h.insert(((t - start) / H).floor() as i64, round_to(v - mean, 3));
            }
            if by_h.len() < 12 {
                why.push(format!("{}: {} hours in the flood", ds, by_h.len()));
                return Ok(None);
            }
            Ok(Some(obj! {"station" => st.0, "uhslc_id" => st.1, "km" => num(round_to(d, 1)), "source" => format!("UHSLC {}", ds),
                "series" => by_h.into_iter().map(|(h, v)| json!([h, num(v)])).collect::<Vec<_>>()}))
        })();
        match attempt {
            Ok(Some(v)) => return Ok((Some(v), None)),
            Ok(None) => {}
            Err(e) => why.push(format!("{}/{}: {}", server.split('/').nth(2).unwrap_or(""), ds, clip(&e, 60))),
        }
    }
    if q.is_some() {
        return Ok((q, None));
    }
    Ok((None, Some(clip(&why.join("; "), 300))))
}

pub fn run_with(events_path: &str, out_path: &str, fetch: Fetch, msq: Msq) -> R<String> {
    let data = read_json(events_path)?;
    let (mut done, mut notes, mut sea) = (Vec::new(), Vec::new(), Map::new());
    for ev in arr(data.get("events")) {
        if !truthy(ev.get("series")) || !truthy(ev.get("start")) {
            continue;
        }
        let id = s_or_empty(ev.get("id"));
        let (got, why) = sea_for(ev, fetch, msq).unwrap_or_else(|e| (None, Some(clip(&e, 200))));
        if let Some(g) = got {
            done.push(format!("{} ({}, {} h)", id, s_or_empty(g.get("station")), arr(g.get("series")).len()));
            println!("got: {}", done.last().unwrap());
            sea.insert(id, g);
        } else if let Some(w) = why.filter(|w| !w.contains("no tide gauge")) {
            notes.push(format!("{}: {}", id, w));
        }
        write_json(out_path, &Value::Object(sea.clone()))?; // keep what's done so far
    }
    write_json(out_path, &Value::Object(sea))?;
    let mut msg = format!("Sea levels: {} recorded floods: {}", done.len(), done.join(", "));
    for n in notes.iter().take(5) {
        msg.push_str(&format!("\nwarning: {}", n));
    }
    Ok(msg)
}

pub fn run(events_path: &str, out_path: &str) -> R<String> {
    let src = MsqSource::new();
    run_with(events_path, out_path, &erddap, &|site, year| src.year(site, year))
}

pub fn merge(events_path: &str, sea_path: &str, out_path: &str) -> R<String> {
    let mut data = read_json(events_path)?;
    let sea = read_json(sea_path).unwrap_or(json!({}));
    if let Some(evs) = data.get_mut("events").and_then(|e| e.as_array_mut()) {
        for ev in evs {
            let id = s_or_empty(ev.get("id"));
            if let Some(s) = sea.get(&id) {
                ev["sea"] = s.clone();
            }
        }
    }
    write_json(out_path, &data)?;
    Ok(String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tide of ±1 m around 1.5 m on the gauge's zero, hourly.
    fn fake(_server: &str, ds: &str, _sid: i64, t0: f64, t1: f64) -> R<Rows> {
        if ds != "global_hourly_rqds" {
            return Err("down".into());
        }
        let epoch2000 = days_from_civil(2000, 1, 1) as f64 * 86400.0;
        let mut out = Vec::new();
        let mut t = t0;
        while t <= t1 {
            let h = (t - epoch2000) / H;
            out.push((t, 1.5 + (2.0 * std::f64::consts::PI * h / 12.42).cos()));
            t += H;
        }
        Ok(out)
    }

    fn no_msq(_: &str, _: i64) -> R<Rows> {
        Ok(Vec::new())
    }

    #[test]
    fn nearest_gauge_within_range() {
        assert_eq!(nearest(-27.47, 153.03).0.unwrap().0, "Brisbane");
        assert!(nearest(-36.12, 144.75).0.is_none(), "Echuca, inland");
    }

    #[test]
    fn series_is_relative_to_the_years_mean() {
        let ev = json!({"id": "b", "lat": -27.47, "lon": 153.03, "start": "2022-02-24T00:00:00+10:00", "series": [[0, 1], [100, 2]]});
        let (sea, why) = sea_for(&ev, &fake, &no_msq).unwrap();
        assert!(why.is_none());
        let sea = sea.unwrap();
        let vals: Vec<f64> = sea["series"].as_array().unwrap().iter().map(|r| r[1].as_f64().unwrap()).collect();
        assert!((vals.iter().cloned().fold(f64::MIN, f64::max) - 1.0).abs() < 0.05);
        assert!((vals.iter().cloned().fold(f64::MAX, f64::min) + 1.0).abs() < 0.05);
        assert_eq!(sea["series"][0][0], -1);
        assert_eq!(sea["station"], "Brisbane");
    }

    #[test]
    fn reads_msq_files_in_either_date_layout() {
        let rows = parse_levels("Date,Time,Level\n12/01/2011 10:00,2.35\n12/01/2011 10:10,2.41,ok\n2011-01-12 10:20 2.50\nheader junk\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].0, days_from_civil(2011, 1, 12) as f64 * 86400.0, "AEST to UTC");
        assert_eq!(rows.iter().map(|r| r.1).collect::<Vec<_>>(), [2.35, 2.41, 2.5]);
    }

    #[test]
    fn reads_msq_archive_lines() {
        let rows = parse_levels("010120170000  0.902\n010120170010  0.854\n311220172350  1.234\n");
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].0, days_from_civil(2016, 12, 31) as f64 * 86400.0 + 14.0 * H, "1 Jan 2017 00:00 AEST");
        assert_eq!(rows[2].1, 1.234);
    }

    #[test]
    fn a_nearer_queensland_gauge_comes_first() {
        let msq = |site: &str, year: i64| -> R<Rows> {
            assert_eq!(site, "Mackay");
            let (mut t, end) = (days_from_civil(year, 1, 1) as f64 * 86400.0, days_from_civil(year + 1, 1, 1) as f64 * 86400.0);
            let mut out = Vec::new();
            while t < end {
                out.push((t, 3.0 + (2.0 * std::f64::consts::PI * t / H / 12.42).cos()));
                t += 600.0;
            }
            Ok(out)
        };
        // Mackay: Townsville's UHSLC gauge is 330 km away
        let ev = json!({"id": "m", "lat": -21.14, "lon": 149.18, "start": "2008-02-14T00:00:00+10:00", "series": [[0, 1], [48, 2]]});
        let (sea, why) = sea_for(&ev, &fake, &msq).unwrap();
        assert!(why.is_none());
        let sea = sea.unwrap();
        assert!(sea["station"].as_str().unwrap().contains("Mackay"));
        let mx = sea["series"].as_array().unwrap().iter().map(|r| r[1].as_f64().unwrap()).fold(f64::MIN, f64::max);
        assert!((mx - 1.0).abs() < 0.05);
    }

    #[test]
    fn main_and_merge() {
        let d = std::env::temp_dir().join(format!("sea-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let (p, sea, out) = (d.join("e.json"), d.join("s.json"), d.join("o.json"));
        std::fs::write(&p, json!({"events": [{"id": "x", "lat": -36.1, "lon": 144.7, "start": "2022-10-12T00:00:00+10:00", "series": [[0, 1]]}]}).to_string()).unwrap();
        run_with(p.to_str().unwrap(), sea.to_str().unwrap(), &fake, &no_msq).unwrap();
        assert_eq!(read_json(&sea).unwrap(), json!({}), "inland: no tide gauge");
        std::fs::write(&sea, json!({"x": {"station": "S", "series": [[0, 0.5]]}}).to_string()).unwrap();
        merge(p.to_str().unwrap(), sea.to_str().unwrap(), out.to_str().unwrap()).unwrap();
        assert_eq!(read_json(&out).unwrap()["events"][0]["sea"]["station"], "S");
        let _ = std::fs::remove_dir_all(d);
    }
}
