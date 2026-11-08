//! `GET /v1/radar`: recent radar rain-rate frames from a directory the person running the broker supplies.
//!
//! The broker does **not** fetch radar from anywhere. Whoever deploys it points `RADAR_DIR` at a
//! folder their own feed fills, and takes responsibility for having the right to serve that data
//! (the manifest must name the source, the attribution and the licence it is served under). The
//! Bureau of Meteorology's anonymous data is "not for commercial use" and its radar images may need
//! a data licence, so this code never touches Bureau services; see docs/radar-nowcast-design.md.
//!
//! The folder holds `radar.json` and one binary file per frame:
//!
//! ```text
//! { "source": "...", "attribution": "...", "licence": "...", "crs": "EPSG:28356",
//!   "grid": { "w": 256, "h": 256, "x0": 0, "y0": 0, "dx": 1000, "dy": 1000 },
//!   "frames": [ { "time": "2026-11-08T05:10:00Z", "file": "20261108T0510Z.f32" }, ... ] }
//! ```
//!
//! Frames are listed oldest first. The grid is north-up with its top-left corner at (`x0`, `y0`),
//! x growing east and y growing south, in metres (the same convention as flood-core's `RadarGrid`).
//! A frame file is `w * h` little-endian `f32` rain rates in mm/h, row by row from the top, with NaN
//! for a cell that was not measured.
//!
//! Query: `bbox=x0,y0,x1,y1` crops to a window in the grid's own coordinates (default the whole
//! grid) and `frames=N` takes the latest N (default 12, at most 36). The answer carries the rates as
//! integer tenths of mm/h, with -1 meaning *missing, not dry*, and says how old the newest frame is.
//! An unconfigured, empty or unreadable store is an error, never an empty "no rain" answer.
use crate::wmip;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const DEFAULT_FRAMES: usize = 12;
pub const MAX_FRAMES: usize = 36;
/// The most values (frames x cells) one answer may carry.
pub const MAX_VALUES: usize = 3_000_000;
/// A newest frame older than this is served, flagged "stale".
pub const STALE_S: i64 = 30 * 60;
const MAX_CELLS: usize = 4_000_000;

struct Grid { w: usize, h: usize, x0: f64, y0: f64, dx: f64, dy: f64 }

struct Manifest { source: String, attribution: String, licence: String, crs: String, grid: Grid, frames: Vec<(i64, String)> }

/// The answer: an HTTP status, the JSON body and whether it may be cached.
pub struct Answer { pub status: u16, pub body: Value, pub cacheable: bool }

fn fail(status: u16, status_word: &str, error: &str) -> Answer {
    Answer { status, body: json!({"status": status_word, "error": error}), cacheable: false }
}

fn text(m: &Value, key: &str) -> Result<String, String> {
    match m.get(key).and_then(Value::as_str).map(str::trim) {
        Some(s) if !s.is_empty() && s.len() <= 500 => Ok(s.to_string()),
        _ => Err(format!("radar.json needs a non-empty \"{key}\"")),
    }
}

fn number(g: &Value, key: &str) -> Result<f64, String> {
    g.get(key).and_then(Value::as_f64).filter(|v| v.is_finite()).ok_or_else(|| format!("radar.json grid needs a number \"{key}\""))
}

fn plain_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn parse_manifest(raw: &str) -> Result<Manifest, String> {
    let m: Value = serde_json::from_str(raw).map_err(|e| format!("radar.json is not valid JSON: {e}"))?;
    let g = m.get("grid").ok_or("radar.json needs a \"grid\"")?;
    let dim = |k: &str| g.get(k).and_then(Value::as_u64).filter(|v| (2..=10_000).contains(v)).map(|v| v as usize).ok_or_else(|| format!("radar.json grid needs a whole number \"{k}\" from 2 to 10000"));
    let grid = Grid { w: dim("w")?, h: dim("h")?, x0: number(g, "x0")?, y0: number(g, "y0")?, dx: number(g, "dx")?, dy: number(g, "dy")? };
    if grid.dx <= 0.0 || grid.dy <= 0.0 { return Err("radar.json grid cell sizes must be positive".into()); }
    if grid.w * grid.h > MAX_CELLS { return Err("radar.json grid is too large".into()); }
    let list = m.get("frames").and_then(Value::as_array).ok_or("radar.json needs a \"frames\" list")?;
    let mut frames = Vec::with_capacity(list.len());
    for f in list {
        let time = f.get("time").and_then(Value::as_str).and_then(wmip::epoch_ms).ok_or("every frame needs an ISO time such as 2026-11-08T05:10:00Z")?;
        let file = f.get("file").and_then(Value::as_str).filter(|n| plain_name(n)).ok_or("every frame needs a plain file name (letters, digits, . _ -)")?;
        frames.push((time, file.to_string()));
    }
    if frames.windows(2).any(|p| p[1].0 <= p[0].0) { return Err("radar.json frames must be listed oldest first, with no repeated times".into()); }
    Ok(Manifest { source: text(&m, "source")?, attribution: text(&m, "attribution")?, licence: text(&m, "licence")?, crs: text(&m, "crs")?, grid, frames })
}

fn query_value(query: &str, key: &str) -> Option<String> {
    query.split('&').filter_map(|kv| kv.split_once('=')).find(|(k, _)| *k == key).map(|(_, v)| wmip::decode(v).trim().to_string())
}

/// The cells of a window `[lo, hi)` along one axis for a span `[a, b]` in metres, or None if it misses the grid.
fn window(a: f64, b: f64, origin: f64, step: f64, n: usize) -> Option<(usize, usize)> {
    let (lo, hi) = (((a - origin) / step).floor().max(0.0), ((b - origin) / step).ceil().min(n as f64));
    if lo < hi { Some((lo as usize, hi as usize)) } else { None }
}

/// Answer a `/v1/radar` request from the folder `dir` at time `now_ms`.
pub fn serve(dir: &Path, query: &str, now_ms: i64) -> Answer {
    let raw = match std::fs::read_to_string(dir.join("radar.json")) {
        Ok(r) => r,
        Err(_) => return fail(503, "unavailable", "the radar store has no radar.json yet"),
    };
    let man = match parse_manifest(&raw) { Ok(m) => m, Err(e) => return fail(502, "misconfigured", &e) };
    if man.frames.is_empty() { return fail(503, "empty", "the radar store has no frames"); }
    let n_frames = match query_value(query, "frames") {
        None => DEFAULT_FRAMES,
        Some(v) => match v.parse::<usize>() { Ok(n) if (1..=MAX_FRAMES).contains(&n) => n, _ => return fail(400, "bad-request", &format!("frames= must be 1 to {MAX_FRAMES}")) },
    };
    let g = &man.grid;
    let (cols, rows) = match query_value(query, "bbox") {
        None => ((0, g.w), (0, g.h)),
        Some(b) => {
            let v: Vec<f64> = b.split(',').filter_map(|s| s.trim().parse::<f64>().ok()).filter(|v| v.is_finite()).collect();
            if v.len() != 4 || b.split(',').count() != 4 || v[0] >= v[2] || v[1] >= v[3] { return fail(400, "bad-request", "bbox= must be x0,y0,x1,y1 with x0 < x1 and y0 < y1, in the grid's own coordinates"); }
            match (window(v[0], v[2], g.x0, g.dx, g.w), window(v[1], v[3], g.y0, g.dy, g.h)) {
                (Some(c), Some(r)) => (c, r),
                _ => return fail(404, "outside", "the window is outside the radar's coverage"),
            }
        }
    };
    let (cw, ch) = (cols.1 - cols.0, rows.1 - rows.0);
    let take = n_frames.min(man.frames.len());
    if take * cw * ch > MAX_VALUES { return fail(400, "too-large", "that is too much data; use bbox= to crop or ask for fewer frames="); }
    let chosen = &man.frames[man.frames.len() - take..];
    let mut frames: Vec<Value> = Vec::with_capacity(take);
    for (_, file) in chosen {
        let bytes = match std::fs::read(dir.join(file)) { Ok(b) => b, Err(_) => return fail(502, "unreadable", "a listed radar frame could not be read") };
        if bytes.len() != g.w * g.h * 4 { return fail(502, "misconfigured", "a radar frame file is not w x h little-endian f32 values"); }
        let mut out = Vec::with_capacity(cw * ch);
        for r in rows.0..rows.1 {
            for c in cols.0..cols.1 {
                let at = (r * g.w + c) * 4;
                let v = f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
                // missing (NaN) and impossible (negative, infinite) values are -1: not measured, and never read as dry
                out.push(if v.is_finite() && v >= 0.0 { (v * 10.0).round().min(10_000.0) as i64 } else { -1 });
            }
        }
        frames.push(json!(out));
    }
    let times: Vec<i64> = chosen.iter().map(|(t, _)| *t).collect();
    let age = ((now_ms - times[times.len() - 1]) / 1000).max(0);
    let gaps: Vec<i64> = times.windows(2).map(|p| (p[1] - p[0]) / 1000).collect();
    let regular = gaps.windows(2).all(|p| p[0] == p[1]);
    let stale = age > STALE_S;
    let body = json!({
        "status": if stale { "stale" } else { "ok" },
        "source": man.source, "attribution": man.attribution, "licence": man.licence, "crs": man.crs,
        "grid": {"w": cw, "h": ch, "x0": g.x0 + cols.0 as f64 * g.dx, "y0": g.y0 + rows.0 as f64 * g.dy, "dx": g.dx, "dy": g.dy},
        "unit": "tenths of mm/h; -1 means missing, not dry",
        "times": times.iter().map(|t| wmip::iso_utc(*t)).collect::<Vec<_>>(),
        "ageSeconds": age, "stepSeconds": if regular { gaps.first().map_or(Value::Null, |g| json!(g)) } else { Value::Null }, "regular": regular,
        "frames": frames,
    });
    Answer { status: 200, body, cacheable: !stale }
}

/// The folder as configured, for /health.
pub fn describe(dir: &Option<PathBuf>) -> Value { json!({"configured": dir.is_some()}) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static N: AtomicUsize = AtomicUsize::new(0);

    const NOW: &str = "2026-11-08T05:30:00Z";
    fn now() -> i64 { wmip::epoch_ms(NOW).unwrap() }
    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("flood-radar-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&d).unwrap(); d
    }
    fn frame_file(dir: &Path, name: &str, w: usize, h: usize, f: impl Fn(usize, usize) -> f32) {
        let mut b = Vec::new();
        for y in 0..h { for x in 0..w { b.extend_from_slice(&f(x, y).to_le_bytes()); } }
        std::fs::write(dir.join(name), b).unwrap();
    }
    /// 4 x 3 grid, frames at the given minutes past 05:00, frame k holds rate = 10k + column
    fn bundle(minutes: &[u32]) -> PathBuf {
        let d = temp();
        let mut frames = Vec::new();
        for (k, m) in minutes.iter().enumerate() {
            let name = format!("f{k}.f32");
            frame_file(&d, &name, 4, 3, |x, _| 10.0 * k as f32 + x as f32 + 0.04);
            frames.push(json!({"time": format!("2026-11-08T05:{m:02}:00Z"), "file": name}));
        }
        let m = json!({"source": "Test radar", "attribution": "Test attribution", "licence": "Test licence", "crs": "EPSG:28356",
            "grid": {"w": 4, "h": 3, "x0": 1000.0, "y0": 5000.0, "dx": 500.0, "dy": 500.0}, "frames": frames});
        std::fs::write(d.join("radar.json"), m.to_string()).unwrap(); d
    }

    #[test]
    fn it_serves_the_latest_frames_with_their_age_and_the_licence() {
        let d = bundle(&[0, 10, 20]);
        let a = serve(&d, "frames=2", now());
        assert_eq!(a.status, 200); assert!(a.cacheable);
        let b = &a.body;
        assert_eq!(b["status"], "ok"); assert_eq!(b["source"], "Test radar"); assert_eq!(b["licence"], "Test licence"); assert_eq!(b["attribution"], "Test attribution");
        assert_eq!(b["times"], json!(["2026-11-08T05:10:00Z", "2026-11-08T05:20:00Z"]));
        assert_eq!(b["ageSeconds"], 600); assert_eq!(b["stepSeconds"], 600); assert_eq!(b["regular"], true);
        assert_eq!(b["grid"], json!({"w": 4, "h": 3, "x0": 1000.0, "y0": 5000.0, "dx": 500.0, "dy": 500.0}));
        // frame index 1 (the 05:10 frame) has rate 10 + column (+0.04): tenths are 100, 110, 120, 130
        assert_eq!(b["frames"][0][0], json!(100)); assert_eq!(b["frames"][0][3], json!(130)); assert_eq!(b["frames"][0].as_array().unwrap().len(), 12);
        assert_eq!(b["frames"][1][0], json!(200));
        assert!(b["unit"].as_str().unwrap().contains("missing, not dry"));
        // by default the latest 12, or all there are
        assert_eq!(serve(&d, "", now()).body["frames"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn a_window_crops_the_grid_and_moves_its_origin() {
        let d = bundle(&[0, 10]);
        // columns 1..3 (x 1500 to 2500) and rows 1..3 (y 5500 to 6500)
        let a = serve(&d, "frames=1&bbox=1600,5600,2400,6400", now());
        assert_eq!(a.status, 200);
        assert_eq!(a.body["grid"], json!({"w": 2, "h": 2, "x0": 1500.0, "y0": 5500.0, "dx": 500.0, "dy": 500.0}));
        assert_eq!(a.body["frames"][0], json!([110, 120, 110, 120]));
        // a window beyond the grid is outside, not empty
        assert_eq!(serve(&d, "bbox=90000,90000,91000,91000", now()).status, 404);
        // a window that only partly overlaps is clipped to the grid
        assert_eq!(serve(&d, "frames=1&bbox=0,0,1600,5600", now()).body["grid"]["w"], 2);
    }

    #[test]
    fn missing_cells_are_minus_one_not_zero() {
        let d = temp();
        frame_file(&d, "a.f32", 2, 2, |x, y| match (x, y) { (0, 0) => f32::NAN, (1, 0) => -3.0, (0, 1) => 0.0, _ => 1e9 });
        let m = json!({"source": "s", "attribution": "a", "licence": "l", "crs": "c", "grid": {"w": 2, "h": 2, "x0": 0, "y0": 0, "dx": 1, "dy": 1}, "frames": [{"time": "2026-11-08T05:25:00Z", "file": "a.f32"}]});
        std::fs::write(d.join("radar.json"), m.to_string()).unwrap();
        let a = serve(&d, "", now());
        assert_eq!(a.body["frames"][0], json!([-1, -1, 0, 10000]), "NaN and negative are missing, 0 is dry, huge is capped");
    }

    #[test]
    fn stale_frames_are_flagged_and_not_cacheable() {
        let d = bundle(&[0, 10]);
        let a = serve(&d, "", wmip::epoch_ms("2026-11-08T06:00:00Z").unwrap());
        assert_eq!(a.status, 200); assert_eq!(a.body["status"], "stale"); assert!(!a.cacheable);
        assert_eq!(a.body["ageSeconds"], 3000);
    }

    #[test]
    fn irregular_spacing_is_reported() {
        let d = bundle(&[0, 10, 25]);
        let a = serve(&d, "", now());
        assert_eq!(a.body["regular"], false); assert!(a.body["stepSeconds"].is_null());
    }

    #[test]
    fn a_store_that_is_missing_empty_or_wrong_is_an_error_never_an_empty_answer() {
        let missing = temp();
        assert_eq!(serve(&missing, "", now()).status, 503);
        let write = |d: &Path, v: Value| std::fs::write(d.join("radar.json"), v.to_string()).unwrap();
        let base = |frames: Value| json!({"source": "s", "attribution": "a", "licence": "l", "crs": "c", "grid": {"w": 2, "h": 2, "x0": 0, "y0": 0, "dx": 1, "dy": 1}, "frames": frames});
        let empty = temp(); write(&empty, base(json!([])));
        let a = serve(&empty, "", now()); assert_eq!(a.status, 503); assert_eq!(a.body["status"], "empty");
        let noname = temp(); write(&noname, base(json!([{"time": "2026-11-08T05:00:00Z", "file": "../etc/passwd"}])));
        assert_eq!(serve(&noname, "", now()).status, 502, "no path tricks in file names");
        let unlisted = temp(); write(&unlisted, base(json!([{"time": "2026-11-08T05:00:00Z", "file": "gone.f32"}])));
        assert_eq!(serve(&unlisted, "", now()).status, 502);
        let short = temp(); std::fs::write(short.join("s.f32"), [0u8; 7]).unwrap(); write(&short, base(json!([{"time": "2026-11-08T05:00:00Z", "file": "s.f32"}])));
        assert_eq!(serve(&short, "", now()).status, 502);
        let unordered = temp(); write(&unordered, base(json!([{"time": "2026-11-08T05:10:00Z", "file": "a"}, {"time": "2026-11-08T05:00:00Z", "file": "b"}])));
        assert_eq!(serve(&unordered, "", now()).status, 502);
        let mut nolicence = base(json!([])); nolicence.as_object_mut().unwrap().remove("licence");
        let nl = temp(); write(&nl, nolicence);
        let a = serve(&nl, "", now()); assert_eq!(a.status, 502); assert!(a.body["error"].as_str().unwrap().contains("licence"), "the licence is required");
        let junk = temp(); std::fs::write(junk.join("radar.json"), "not json").unwrap();
        assert_eq!(serve(&junk, "", now()).status, 502);
    }

    #[test]
    fn bad_queries_and_oversize_requests_are_refused() {
        let d = bundle(&[0, 10]);
        for q in ["frames=0", "frames=99", "frames=x", "bbox=1,2,3", "bbox=5,5,1,1", "bbox=a,b,c,d", "bbox=1,2,3,4,5"] {
            assert_eq!(serve(&d, q, now()).status, 400, "{q}");
        }
        assert!(!serve(&d, "", now()).body.to_string().contains(d.to_str().unwrap()), "no filesystem paths in answers");
        // too many values: a 3000 x 1100 grid for 1 frame is 3.3 million values
        let big = temp();
        frame_file(&big, "b.f32", 3000, 1100, |_, _| 0.0);
        let m = json!({"source": "s", "attribution": "a", "licence": "l", "crs": "c", "grid": {"w": 3000, "h": 1100, "x0": 0, "y0": 0, "dx": 1, "dy": 1}, "frames": [{"time": "2026-11-08T05:25:00Z", "file": "b.f32"}]});
        std::fs::write(big.join("radar.json"), m.to_string()).unwrap();
        let a = serve(&big, "", now()); assert_eq!(a.status, 400); assert_eq!(a.body["status"], "too-large");
        assert_eq!(serve(&big, "bbox=0,0,100,100", now()).status, 200, "cropping makes it fit");
    }
}
