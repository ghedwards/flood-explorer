//! Tide heights around the Australian coast (EOT20 tidal statistics,
//! NESP MaC 3.17, AIMS; was pipeline/fetch_tides.py).
//!
//! Usage: flood tides <out.json>
//!
//! Follows the dataset's link to its public Nextcloud share, lists it over
//! WebDAV, downloads the Highest Predicted Tide and Mean High Water Springs
//! grids and keeps every other coastal cell. Writes {source, files,
//! fetched, points: [[lat, lon, hat, mhws], ...]} (metres above mean sea
//! level).

use crate::geo::{read_geotiff, Raster};
use crate::net;
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{json, Value};

const ALIAS: &str = "https://nextcloud.eatlas.org.au/apps/sharealias/a/AU_NESP-MaC-3-17_AIMS_EOT20-tidal-stats_v1-1";
const DAV: &str = "https://nextcloud.eatlas.org.au/public.php/webdav";

fn share_token() -> R<String> {
    let r = net::get(ALIAS, &[], 60).map_err(|e| format!("{}: {}", ALIAS, e))?;
    let body = String::from_utf8_lossy(&r.body[..r.body.len().min(200000)]).into_owned();
    let re = Regex::new(r"/s/([A-Za-z0-9]{8,})").unwrap();
    for t in [&r.url, &body] {
        if let Some(c) = re.captures(t) {
            return Ok(c[1].to_string());
        }
    }
    Err(format!("no share token behind {} (ended at {})", ALIAS, r.url))
}

pub fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                o.push(T[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                o.push('=');
            }
        }
    }
    o
}

/// Files under a public share: [(path, size)], walking folders.
fn webdav_list(auth: &str) -> R<Vec<(String, u64)>> {
    let (mut out, mut todo) = (Vec::new(), vec!["/".to_string()]);
    let resp = Regex::new(r"(?is)<(?:\w+:)?response\b[^>]*>(.*?)</(?:\w+:)?response>").unwrap();
    let href = Regex::new(r"(?is)<(?:\w+:)?href\b[^>]*>(.*?)</(?:\w+:)?href>").unwrap();
    let coll = Regex::new(r"(?i)<(?:\w+:)?collection\b").unwrap();
    let size = Regex::new(r"(?is)<(?:\w+:)?getcontentlength\b[^>]*>\s*(\d+)\s*<").unwrap();
    while let Some(p) = todo.pop() {
        if out.len() >= 2000 {
            break;
        }
        let r = net::request_ext("PROPFIND", &format!("{}{}", DAV, net::quote(&p, "/")), &[("Depth", "1"), ("Authorization", auth)], None, 60).map_err(|e| e.to_string())?;
        let xml = r.text();
        for m in resp.captures_iter(&xml) {
            let block = &m[1];
            let Some(h) = href.captures(block) else { continue };
            let h = net::unquote(&html_unescape(&h[1]));
            let rel = h.splitn(2, "/public.php/webdav").last().unwrap_or("").to_string();
            if rel.trim_end_matches('/') == p.trim_end_matches('/') {
                continue;
            }
            if coll.is_match(block) {
                todo.push(rel);
            } else {
                out.push((rel, size.captures(block).and_then(|c| c[1].parse().ok()).unwrap_or(0)));
            }
        }
    }
    Ok(out)
}

/// The GeoTIFF whose name has all the words, preferring whole-of-Australia
/// files over monthly ones, then the largest.
pub fn pick<'a>(files: &'a [(String, u64)], words: &[&str]) -> Option<&'a (String, u64)> {
    let cands: Vec<&(String, u64)> = files.iter().filter(|f| {
        let l = f.0.to_lowercase();
        (l.ends_with(".tif") || l.ends_with(".tiff")) && words.iter().all(|w| l.contains(w))
    }).collect();
    let whole: Vec<&(String, u64)> = cands.iter().copied().filter(|f| !f.0.to_lowercase().contains("month")).collect();
    let pool = if whole.is_empty() { cands } else { whole };
    let mut best: Option<&(String, u64)> = None;
    for f in pool {
        if best.is_none_or(|b| f.1 > b.1) {
            best = Some(f);
        }
    }
    best
}

/// Sea cells next to land (no data), every `step`-th in a checkerboard.
/// The EOT20 grids cover a wider region than Australia (they extend to
/// Indonesia and New Zealand), so keep only the Australian coastal box.
pub fn coastal_points(hat: &Raster, mh: &Raster, step: usize) -> Vec<Value> {
    let (w, h) = (hat.w, hat.h);
    let val = |r: &Raster, i: usize| -> f64 {
        let v = r.data[i] as f32 as f64;
        if r.is_nodata(v) { f64::NAN } else { v }
    };
    let ok: Vec<bool> = (0..w * h).map(|i| {
        let (a, b) = (val(hat, i), if i < mh.data.len() { val(mh, i) } else { f64::NAN });
        a.is_finite() && b.is_finite() && a.abs() < 20.0
    }).collect();
    let mut pts = Vec::new();
    for r in 0..h {
        for c in 0..w {
            let i = r * w + c;
            if !ok[i] {
                continue;
            }
            let lon = hat.x0 + (c as f64 + 0.5) * hat.dx;
            let lat = hat.y0 - (r as f64 + 0.5) * hat.dy;
            // mainland + Tasmania (+ islands close in); excludes the Indonesian,
            // Papua New Guinean and New Zealand coasts the grids also cover
            if !(111.5..=155.0).contains(&lon) || !(-45.0..=-9.5).contains(&lat) {
                continue;
            }
            let near = (r > 0 && !ok[i - w]) || (r + 1 < h && !ok[i + w]) || (c > 0 && !ok[i - 1]) || (c + 1 < w && !ok[i + 1]);
            if !near || (r + c) % step != 0 {
                continue;
            }
            pts.push(json!([num(round_to(lat, 3)), num(round_to(lon, 3)), num(round_to(val(hat, i), 2)), num(round_to(val(mh, i), 2))]));
        }
    }
    pts
}

pub fn run(out_path: &str) -> R<String> {
    let token = share_token()?;
    let auth = format!("Basic {}", base64(format!("{}:", token).as_bytes()));
    let files = webdav_list(&auth)?;
    let hat = pick(&files, &["hpt"]).or_else(|| pick(&files, &["hat"]));
    let mhws = pick(&files, &["mhws"]).or_else(|| pick(&files, &["mhsw"]));
    let (Some(hat), Some(mhws)) = (hat, mhws) else {
        let names: Vec<&str> = files.iter().take(12).map(|f| f.0.as_str()).collect();
        return Err(format!("HPT or MHWS grid not found among {} files ({})", files.len(), names.join(", ")));
    };
    let download = |rel: &str| -> R<Raster> {
        let r = net::get(&format!("{}{}", DAV, net::quote(rel, "/")), &[("Authorization", &auth)], 600).map_err(|e| format!("{}: {}", rel, e))?;
        read_geotiff(&r.body)
    };
    let (hr, mr) = (download(&hat.0)?, download(&mhws.0)?);
    let pts = coastal_points(&hr, &mr, 2);
    let n = pts.len();
    write_json(out_path, &obj! {
        "source" => "Tidal Statistics for Australia from the EOT20 tidal model (NESP MaC 3.17, AIMS), v1-1, CC BY 4.0",
        "files" => vec![hat.0.clone(), mhws.0.clone()], "fetched" => now_iso(), "points" => pts,
    })?;
    let base = |s: &str| s.rsplit('/').next().unwrap_or(s).to_string();
    Ok(format!("Tides: {} coastal points from {} and {}", n, base(&hat.0), base(&mhws.0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::write_geotiff_f32;

    #[test]
    fn picks_the_whole_country_grids() {
        let f: Vec<(String, u64)> = [("/v1-1/HPT_2019-2023.tif", 9000), ("/v1-1/monthly/HPT_monthly.tif", 99000), ("/v1-1/MHWS_2019-2023.tif", 9000), ("/v1-1/LPT_2019-2023.tif", 9000), ("/v1-1/readme.txt", 10)]
            .iter().map(|(a, b)| (a.to_string(), *b)).collect();
        assert_eq!(pick(&f, &["hpt"]).unwrap().0, "/v1-1/HPT_2019-2023.tif");
        assert_eq!(pick(&f, &["mhws"]).unwrap().0, "/v1-1/MHWS_2019-2023.tif");
        assert!(pick(&f, &["nothing"]).is_none());
        assert_eq!(base64(b"tok:"), "dG9rOg==");
    }

    #[test]
    fn keeps_sea_cells_next_to_land() {
        let mut hat = vec![1.5f32; 36];
        for r in 0..6 {
            for c in 0..3 {
                hat[r * 6 + c] = -9999.0; // land on the west half
            }
        }
        let mh: Vec<f32> = hat.iter().map(|&v| if v > -9999.0 { 1.1 } else { -9999.0 }).collect();
        let d = std::env::temp_dir();
        let (ph, pm) = (d.join(format!("h-{}.tif", std::process::id())), d.join(format!("m-{}.tif", std::process::id())));
        write_geotiff_f32(&ph, 6, 6, &hat, 150.0, -20.0, 0.03125, 4326, -9999.0).unwrap();
        write_geotiff_f32(&pm, 6, 6, &mh, 150.0, -20.0, 0.03125, 4326, -9999.0).unwrap();
        let (h, m) = (read_geotiff(&std::fs::read(&ph).unwrap()).unwrap(), read_geotiff(&std::fs::read(&pm).unwrap()).unwrap());
        let pts = coastal_points(&h, &m, 2);
        assert_eq!(pts.len(), 3, "column 3 is the coast; every other cell kept");
        assert!(pts.iter().all(|p| p[2] == 1.5 && p[3] == 1.1));
        assert!(pts.iter().all(|p| (p[1].as_f64().unwrap() - (150.0 + 3.5 * 0.03125)).abs() < 1e-3));
        let _ = (std::fs::remove_file(ph), std::fs::remove_file(pm));
    }
}
