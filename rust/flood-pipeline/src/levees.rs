//! Published levee lines in one GeoJSON file (was pipeline/fetch_levees.py).
//!
//! Usage: flood levees <out.geojson>
//!
//! NSW: the state's levee audit shapefiles (found through the SEED or NSW
//! data portal catalogue), reprojected to lon/lat from their .prj. Victoria:
//! the coastal levees from the state's map server (WFS). Writes LineStrings
//! with {name, source, type}, coordinates rounded to about a metre.

use crate::geo::{dbf_records, shp_lines, Proj};
use crate::net;
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{json, Value};

const SEED: &str = "https://datasets.seed.nsw.gov.au/api/3/action/package_search";
const DATANSW: &str = "https://data.nsw.gov.au/data/api/3/action/package_search";
const VIC_WFS: &str = "https://opendata.maps.vic.gov.au/geoserver/wfs";

/// (url, timeout s) -> body
pub type Get<'a> = &'a dyn Fn(&str, u64) -> R<Vec<u8>>;

pub fn get(url: &str, timeout: u64) -> R<Vec<u8>> {
    net::get(url, &[("Accept", "application/json, application/zip, */*")], timeout).map(|r| r.body).map_err(|e| e.to_string())
}

fn get_json(g: Get, url: &str, timeout: u64) -> R<Value> {
    let b = g(url, timeout)?;
    serde_json::from_slice(&b).map_err(|_| format!("not JSON: {:?}", String::from_utf8_lossy(&b[..b.len().min(80)])))
}

/// Rounded to 5 decimals, repeats dropped; None if under two points.
pub fn round_line(coords: &[(f64, f64)]) -> Option<Vec<Value>> {
    let mut out: Vec<(f64, f64)> = Vec::new();
    for &(x, y) in coords {
        let p = (round_to(x, 5), round_to(y, 5));
        if out.last() != Some(&p) {
            out.push(p);
        }
    }
    if out.len() >= 2 { Some(out.into_iter().map(|(x, y)| json!([num(x), num(y)])).collect()) } else { None }
}

fn line_feature(line: Vec<Value>, name: &str, source: &str, typ: &str) -> Value {
    obj! {"type" => "Feature", "geometry" => obj! {"type" => "LineString", "coordinates" => line}, "properties" => obj! {"name" => name, "source" => source, "type" => typ}}
}

/// Lines from a zipped shapefile, in lon/lat.
pub fn shapefile_lines(zbytes: &[u8], name: &str, source: &str) -> R<Vec<Value>> {
    let files = unzip(zbytes)?;
    let mut feats = Vec::new();
    for (path, shp) in files.iter().filter(|(n, _)| n.to_lowercase().ends_with(".shp")) {
        let Some(stem) = path.get(..path.len().saturating_sub(4)) else { continue };
        let sibling = |ext: &str| files.iter().find(|(n, _)| n.strip_prefix(stem).is_some_and(|rest| rest.eq_ignore_ascii_case(ext))).map(|f| &f.1);
        let proj = match sibling(".prj") {
            Some(p) => Proj::from_wkt(&String::from_utf8_lossy(p)).ok_or_else(|| format!("unknown projection in {}.prj", stem))?,
            None => Proj::Geographic, // GDA94
        };
        let (fields, recs) = sibling(".dbf").map(|d| dbf_records(d)).transpose()?.unwrap_or_default();
        for (rec, pts) in shp_lines(shp)? {
            let typ = recs.get(rec).and_then(|r| fields.iter().zip(r).find(|(k, v)| k.to_lowercase().contains("type") && !v.is_empty()).map(|(_, v)| v.clone())).unwrap_or_default();
            let ll: Vec<(f64, f64)> = pts.iter().map(|&(x, y)| proj.to_lonlat(x, y)).collect();
            if let Some(line) = round_line(&ll) {
                feats.push(line_feature(line, name, source, &typ));
            }
        }
    }
    Ok(feats)
}

fn nsw_levees(g: Get, notes: &mut Vec<String>) -> R<Vec<Value>> {
    let q = net::urlencode(&[("q", "levee"), ("rows", "200")]);
    let mut pkgs: Vec<Value> = Vec::new();
    let mut why = Vec::new();
    for api in [SEED, DATANSW] {
        let host = api.split('/').nth(2).unwrap_or("");
        match get_json(g, &format!("{}?{}", api, q), 90) {
            Ok(j) => {
                pkgs = arr(j.get("result").and_then(|r| r.get("results"))).iter().filter(|p| s_or_empty(p.get("title")).to_lowercase().contains("levee")).cloned().collect();
                if pkgs.is_empty() {
                    why.push(format!("{}: no levee datasets", host));
                } else {
                    notes.push(format!("catalogue {}: {} datasets", host, pkgs.len()));
                    break;
                }
            }
            Err(e) => why.push(format!("{}: {}", host, clip(&e, 70))),
        }
    }
    if pkgs.is_empty() {
        return Err(if why.is_empty() { "no levee datasets found".into() } else { why.join("; ") });
    }
    let mut feats = Vec::new();
    for pkg in &pkgs {
        let title = s_or_empty(pkg.get("title"));
        let name = title.split(" - ").next().unwrap_or("").replace("Centreline", "").replace("centreline", "");
        let name = name.trim_matches(|c| c == ' ' || c == '-').to_string();
        for res in arr(pkg.get("resources")) {
            let fmt = s_or_empty(res.get("format")).to_lowercase();
            let url = s_or_empty(res.get("url"));
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                continue;
            }
            if !fmt.contains("shp") && !fmt.contains("zip") && !url.to_lowercase().ends_with(".zip") {
                continue;
            }
            match g(&url, 90).and_then(|b| shapefile_lines(&b, &name, "NSW levee audit")) {
                Ok(got) => {
                    notes.push(format!("{}: {}", name, got.len()));
                    feats.extend(got);
                    break;
                }
                Err(e) => notes.push(format!("{}: failed ({})", name, clip(&e, 60))),
            }
        }
    }
    Ok(feats)
}

fn vic_coastal(g: Get, notes: &mut Vec<String>) -> R<Vec<Value>> {
    let caps = String::from_utf8_lossy(&g(&format!("{}?service=WFS&version=1.0.0&request=GetCapabilities", VIC_WFS), 180)?).into_owned();
    let re = Regex::new(r"(?i)<Name>([^<]*levee[^<]*)</Name>").unwrap();
    let names: Vec<String> = re.captures_iter(&caps).map(|c| c[1].to_string()).collect();
    if names.is_empty() {
        return Err("no levee layer on the Victorian map server".into());
    }
    let layer = names.iter().find(|n| n.to_lowercase().contains("coast")).unwrap_or(&names[0]).clone();
    notes.push(format!("Victoria layer {}", layer));
    let p = net::urlencode(&[("service", "WFS"), ("version", "1.0.0"), ("request", "GetFeature"), ("typeName", layer.as_str()), ("outputFormat", "application/json"), ("srsName", "EPSG:4326"), ("maxFeatures", "20000")]);
    let j = get_json(g, &format!("{}?{}", VIC_WFS, p), 180)?;
    let mut feats = Vec::new();
    let pts = |v: &Value| -> Vec<(f64, f64)> { arr(Some(v)).iter().map(|c| (c[0].as_f64().unwrap_or(f64::NAN), c[1].as_f64().unwrap_or(f64::NAN))).collect() };
    for f in arr(j.get("features")) {
        let geom = f.get("geometry").cloned().unwrap_or(Value::Null);
        let lines: Vec<&Value> = match get_str(&geom, "type") {
            Some("LineString") => vec![&geom["coordinates"]],
            Some("MultiLineString") => arr(geom.get("coordinates")).iter().collect(),
            _ => vec![],
        };
        for ln in lines {
            if let Some(line) = round_line(&pts(ln)) {
                feats.push(line_feature(line, "Coastal levee", "Victoria coastal levees (DEECA)", ""));
            }
        }
    }
    notes.push(format!("Victoria coastal: {}", feats.len()));
    Ok(feats)
}

pub fn run(out_path: &str, g: Get) -> R<String> {
    let (mut notes, mut feats) = (Vec::new(), Vec::new());
    match nsw_levees(g, &mut notes) {
        Ok(f) => feats.extend(f),
        Err(e) => notes.push(format!("nsw_levees: unavailable ({})", clip(&e, 80))),
    }
    match vic_coastal(g, &mut notes) {
        Ok(f) => feats.extend(f),
        Err(e) => notes.push(format!("vic_coastal: unavailable ({})", clip(&e, 80))),
    }
    let n = feats.len();
    write_json(out_path, &obj! {"type" => "FeatureCollection", "features" => feats})?;
    Ok(format!("Levees: {} lines ({})", n, clip(&notes.join("; "), 900)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_line_drops_repeats_and_short_lines() {
        assert_eq!(round_line(&[(1.000001, 2.0), (1.000002, 2.0), (1.1, 2.1)]).unwrap(), vec![json!([1.0, 2.0]), json!([1.1, 2.1])]);
        assert!(round_line(&[(1.0, 2.0), (1.000001, 2.0)]).is_none());
    }

    #[test]
    fn survives_unreachable_sources() {
        let p = std::env::temp_dir().join(format!("lv-{}.geojson", std::process::id()));
        run(p.to_str().unwrap(), &|_: &str, _: u64| -> R<Vec<u8>> { Err("unreachable".into()) }).unwrap();
        assert_eq!(read_json(&p).unwrap()["features"], json!([]));
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn zipped_shapefile_in_mga_comes_out_in_lonlat() {
        let proj = Proj::from_epsg(28356).unwrap();
        let (a, b) = (proj.project_lonlat(153.0, -28.8), proj.project_lonlat(153.01, -28.81));
        let mut rec = Vec::new();
        rec.extend(3i32.to_le_bytes());
        rec.extend([0u8; 32]);
        rec.extend(1i32.to_le_bytes());
        rec.extend(2i32.to_le_bytes());
        rec.extend(0i32.to_le_bytes());
        for v in [a.0, a.1, b.0, b.1] {
            rec.extend(v.to_le_bytes());
        }
        let mut shp = vec![0u8; 100];
        shp[..4].copy_from_slice(&9994u32.to_be_bytes());
        shp.extend(1u32.to_be_bytes());
        shp.extend(((rec.len() / 2) as u32).to_be_bytes());
        shp.extend(rec);
        let prj = br#"PROJCS["GDA_1994_MGA_Zone_56",GEOGCS["GCS_GDA_1994",DATUM["D_GDA_1994",SPHEROID["GRS_1980",6378137.0,298.257222101]]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",153.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]"#;
        let z = zip_stored(&[("Lismore/levee.shp", &shp), ("Lismore/levee.prj", prj)]);
        let f = shapefile_lines(&z, "Lismore", "NSW levee audit").unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0]["geometry"]["coordinates"], json!([[153.0, -28.8], [153.01, -28.81]]));
    }
}
