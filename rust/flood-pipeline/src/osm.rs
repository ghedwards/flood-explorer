//! Copies of OpenStreetMap buildings, roads and key sites for each preset
//! (was pipeline/fetch_osm.py).
//!
//! Usage: flood osm <viewer/app.js> <out_dir> [--max N] [--days D]
//!
//! Each run refreshes up to N presets (missing or outdated copies first,
//! then any older than D days) through the Overpass API, using the app's own
//! query. Writes <out_dir>/<id>.json {id, v, bbox, fetched, b, f, nodes,
//! roads, sites} and <out_dir>/index.json.

use crate::net;
use crate::obj;
use crate::util::*;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const OVERPASS: [&str; 3] = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
];
const HALF_KM: f64 = 13.0;
pub const VERSION: i64 = 2;
const SITE_KINDS: [(&str, &str); 11] = [
    ("hospital", "Hospital"), ("clinic", "Clinic"), ("doctors", "Doctors"), ("school", "School"), ("kindergarten", "Kindergarten"),
    ("childcare", "Childcare"), ("nursing_home", "Aged care"), ("fire_station", "Fire station"), ("police", "Police"),
    ("ambulance_station", "Ambulance"), ("community_centre", "Community centre"),
];
const ROAD_TYPES: &str = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street";
const HOMES: &str = "house|residential|detached|semidetached_house|terrace|apartments|bungalow|dormitory|duplex|cabin";
const WORK: &str = "commercial|retail|industrial|office|warehouse|supermarket|school|university|college|hospital|public|civic|government|kindergarten";

#[derive(Clone, Debug)]
pub struct Preset {
    pub id: String,
    pub lat: f64,
    pub lon: f64,
}

/// The presets listed inline or imported by the app. Also accepts presets.js.
pub fn presets(app_js: &str) -> R<Vec<Preset>> {
    let mut src = std::fs::read_to_string(app_js).map_err(|e| format!("{}: {}", app_js, e))?;
    if !src.contains("const PRESETS = [") {
        // Read the local module instead of evaluating JavaScript. Keep the CLI's
        // existing app.js argument working for ratings and OSM snapshots.
        let import = Regex::new(r#"(?m)^import\s*\{[^}]*\bPRESETS\b[^}]*\}\s*from\s*['"](\./[^'"]+)['"]"#).unwrap();
        let module = import.captures(&src).ok_or("no PRESETS definition or local import in the app")?;
        let module_path = Path::new(app_js).parent().unwrap_or(Path::new(".")).join(&module[1]);
        src = std::fs::read_to_string(&module_path).map_err(|e| format!("{}: {}", module_path.display(), e))?;
    }
    let i = src.find("const PRESETS = [").ok_or("no PRESETS in the module")?;
    let block = &src[i..];
    let block = &block[..block.find("];").ok_or("PRESETS not closed")?];
    let pat = Regex::new(r"(?s)id: '([^']+)'.*?lat: (-?[\d.]+), lon: (-?[\d.]+)").unwrap();
    Ok(pat.captures_iter(block).map(|m| Preset { id: m[1].to_string(), lat: m[2].parse().unwrap_or(f64::NAN), lon: m[3].parse().unwrap_or(f64::NAN) }).collect())
}

pub fn bbox(lat: f64, lon: f64) -> [f64; 4] {
    let dlat = HALF_KM * 1000.0 / 110574.0;
    let dlon = HALF_KM * 1000.0 / (111320.0 * lat.to_radians().cos());
    [round_to(lat - dlat, 5), round_to(lon - dlon, 5), round_to(lat + dlat, 5), round_to(lon + dlon, 5)]
}

pub fn query(bb: &[f64; 4]) -> String {
    let b = bb.iter().map(|v| py_float(*v)).collect::<Vec<_>>().join(",");
    let mark = |n: &str| format!("make marker name=\"{}\";out;", n);
    let sites = SITE_KINDS.iter().map(|s| s.0).collect::<Vec<_>>().join("|");
    format!(
        "[out:json][timeout:240];\
{m1}way[\"building\"]({b});out ids center qt;\
{m2}way[\"building\"~\"^({homes})$\"]({b});out ids qt;\
{m3}way[\"building\"~\"^({work})$\"]({b});out ids qt;\
{m4}way[\"highway\"~\"^({roads})(_link)?$\"]({b});out body geom qt;\
{m5}nwr[\"amenity\"~\"^({sites})$\"]({b});out tags center qt;\
nwr[\"social_facility\"~\"^(nursing_home|assisted_living)$\"]({b});out tags center qt;\
nwr[\"emergency\"~\"^(evacuation_centre|evacuation_center)$\"]({b});out tags center qt;\
nwr[\"evacuation_centre\"=\"yes\"]({b});out tags center qt;nwr[\"evacuation_center\"=\"yes\"]({b});out tags center qt;",
        m1 = mark("buildings"), m2 = mark("homes"), m3 = mark("work"), m4 = mark("roads"), m5 = mark("sites"),
        b = b, homes = HOMES, work = WORK, roads = ROAD_TYPES, sites = sites
    )
}

pub fn overpass(q: &str) -> R<Value> {
    let mut last = String::new();
    for url in OVERPASS {
        let body = net::urlencode(&[("data", q)]);
        let r = net::request("POST", url, &[("Content-Type", "application/x-www-form-urlencoded")], Some(body.as_bytes()), 300)
            .map_err(|e| e.to_string())
            .and_then(|r| serde_json::from_slice::<Value>(&r.body).map_err(err));
        match r {
            Ok(j) => {
                let remark = j.get("remark").map(py_str).unwrap_or_default();
                if j.get("remark").is_some() && remark.to_lowercase().contains("error") {
                    last = clip(&remark, 120);
                    continue;
                }
                return Ok(j);
            }
            Err(e) => last = e,
        }
    }
    Err(format!("OpenStreetMap service unavailable ({})", clip(&last, 120)))
}

/// The app's structures, in a compact form.
pub fn compact(osm: &Value, pid: &str, bb: &[f64; 4]) -> Value {
    let (mut b, mut f): (Vec<Value>, Vec<i64>) = (Vec::new(), Vec::new());
    let mut idx: Vec<(Value, usize)> = Vec::new();
    let mut idx_map: HashMap<String, usize> = HashMap::new();
    let (mut homes, mut work) = (HashSet::new(), HashSet::new());
    let (mut nodes, mut roads, mut sites): (Vec<Value>, Vec<Value>, Vec<Value>) = (Vec::new(), Vec::new(), Vec::new());
    let mut node_idx: HashMap<String, usize> = HashMap::new();
    let mut section = String::new();
    let r6 = |v: &Value| num(round_to(v.as_f64().unwrap_or(f64::NAN), 6));
    for e in arr(osm.get("elements")) {
        if get_str(e, "type") == Some("marker") {
            section = e.get("tags").and_then(|t| t.get("name")).map(py_str).unwrap_or_default();
            continue;
        }
        let id = e.get("id").map(|v| v.to_string()).unwrap_or_default();
        match section.as_str() {
            "buildings" if truthy(e.get("center")) => {
                if !idx_map.contains_key(&id) {
                    idx_map.insert(id.clone(), f.len());
                    idx.push((e["id"].clone(), f.len()));
                    b.push(r6(&e["center"]["lon"]));
                    b.push(r6(&e["center"]["lat"]));
                    f.push(0);
                }
            }
            "homes" => {
                homes.insert(id);
            }
            "work" => {
                work.insert(id);
            }
            "roads" if truthy(e.get("geometry")) => {
                let tags = e.get("tags").cloned().unwrap_or(json!({}));
                let pts = arr(e.get("geometry"));
                let ids: Vec<String> = {
                    let n = arr(e.get("nodes"));
                    if n.len() == pts.len() {
                        n.iter().map(|x| x.to_string()).collect()
                    } else {
                        pts.iter().map(|p| format!("{:.6},{:.6}", p["lat"].as_f64().unwrap_or(0.0), p["lon"].as_f64().unwrap_or(0.0))).collect()
                    }
                };
                let mut seq = Vec::new();
                for (nid, p) in ids.iter().zip(pts) {
                    if p.is_null() {
                        continue;
                    }
                    let k = *node_idx.entry(nid.clone()).or_insert_with(|| {
                        nodes.push(r6(&p["lat"]));
                        nodes.push(r6(&p["lon"]));
                        nodes.len() / 2 - 1
                    });
                    seq.push(k);
                }
                if seq.len() >= 2 {
                    let name = or_v(tags.get("name"), tags.get("ref"));
                    roads.push(json!([if truthy(Some(&name)) { name } else { json!("") }, tags.get("highway").cloned().unwrap_or(json!("")), seq]));
                }
            }
            "sites" if truthy(e.get("tags")) => {
                let t = &e["tags"];
                let ll = if truthy(e.get("center")) {
                    Some((e["center"]["lat"].clone(), e["center"]["lon"].clone()))
                } else if e.get("lat").is_some() {
                    Some((e["lat"].clone(), e["lon"].clone()))
                } else {
                    None
                };
                let ts = |k: &str| get_str(t, k).unwrap_or("");
                let evac = matches!(ts("emergency"), "evacuation_centre" | "evacuation_center") || ts("evacuation_centre") == "yes" || ts("evacuation_center") == "yes";
                let kind = if evac {
                    Some("Evacuation centre")
                } else {
                    SITE_KINDS.iter().find(|s| s.0 == ts("amenity")).map(|s| s.1).or(if truthy(t.get("social_facility")) { Some("Aged care") } else { None })
                };
                if let (Some((lat, lon)), Some(kind)) = (ll, kind) {
                    let name = if truthy(t.get("name")) { t["name"].clone() } else { json!(kind) };
                    sites.push(json!([name, kind, r6(&lat), r6(&lon)]));
                }
            }
            _ => {}
        }
    }
    for (id, i) in &idx {
        let k = id.to_string();
        f[*i] = (if homes.contains(&k) { 1 } else { 0 }) | (if work.contains(&k) { 2 } else { 0 });
    }
    obj! {"id" => pid, "v" => VERSION, "bbox" => bb.to_vec(), "fetched" => now_iso(), "b" => b, "f" => f, "nodes" => nodes, "roads" => roads, "sites" => sites}
}

fn age_days(path: &Path) -> f64 {
    let Ok(d) = read_json(path) else { return f64::INFINITY };
    if d.get("v").and_then(|v| v.as_i64()).unwrap_or(1) < VERSION {
        return f64::INFINITY;
    }
    match get_str(&d, "fetched").and_then(|t| parse_iso(t, 0)) {
        Some(t) => (now_s() - t) / 86400.0,
        None => f64::INFINITY,
    }
}

pub fn run(app_js: &str, out_dir: &str, max_n: usize, days: f64, budget_s: f64, overpass: &dyn Fn(&str) -> R<Value>, sleep: &dyn Fn(f64)) -> R<String> {
    let out = Path::new(out_dir);
    std::fs::create_dir_all(out).map_err(err)?;
    let ps = presets(app_js)?;
    let mut todo: Vec<(f64, &Preset)> = ps.iter().map(|p| (age_days(&out.join(format!("{}.json", p.id))), p)).collect();
    todo.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let todo: Vec<&Preset> = todo.into_iter().filter(|(a, _)| *a > days).map(|x| x.1).take(max_n).collect();
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    let t0 = now_s();
    for p in todo {
        if now_s() - t0 > budget_s {
            break;
        }
        let bb = bbox(p.lat, p.lon);
        match overpass(&query(&bb)).map(|j| compact(&j, &p.id, &bb)) {
            Ok(d) => {
                write_json(out.join(format!("{}.json", p.id)), &d)?;
                done.push(format!("{} ({})", p.id, arr(d.get("f")).len()));
            }
            Err(e) => failed.push(format!("{}: {}", p.id, clip(&e, 80))),
        }
        sleep(2.0); // be gentle with the shared service
    }
    let ids: HashSet<&str> = ps.iter().map(|p| p.id.as_str()).collect();
    let mut files: Vec<_> = std::fs::read_dir(out).map_err(err)?.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    let mut index = Vec::new();
    for path in files {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem == "index" || !ids.contains(stem) {
            continue;
        }
        let Ok(d) = read_json(&path) else { continue };
        if d.get("id").is_none() || d.get("bbox").is_none() || d.get("fetched").is_none() || d.get("f").is_none() {
            continue;
        }
        index.push(obj! {"id" => d["id"].clone(), "bbox" => d["bbox"].clone(), "fetched" => d["fetched"].clone(), "buildings" => arr(d.get("f")).len()});
    }
    write_json(out.join("index.json"), &Value::Array(index.clone()))?;
    let mut msg = format!("OpenStreetMap copies: {} of {} presets; refreshed {}: {}", index.len(), ps.len(), done.len(), clip(&done.join(", "), 500));
    for f in failed.iter().take(5) {
        msg.push_str(&format!("\nwarning: {}", f));
    }
    Ok(msg)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn app() -> String {
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../viewer/app.js").to_string()
    }

    fn osm() -> Value {
        json!({"elements": [
            {"type": "marker", "tags": {"name": "buildings"}},
            {"type": "way", "id": 1, "center": {"lat": -27.1, "lon": 153.1}},
            {"type": "way", "id": 2, "center": {"lat": -27.2, "lon": 153.2}},
            {"type": "way", "id": 2, "center": {"lat": -27.2, "lon": 153.2}},
            {"type": "marker", "tags": {"name": "homes"}}, {"type": "way", "id": 1},
            {"type": "marker", "tags": {"name": "work"}}, {"type": "way", "id": 2},
            {"type": "marker", "tags": {"name": "roads"}},
            {"type": "way", "id": 9, "tags": {"name": "A St", "highway": "residential"}, "nodes": [5, 6, 7],
             "geometry": [{"lat": -27, "lon": 153}, {"lat": -27.01, "lon": 153}, {"lat": -27.02, "lon": 153}]},
            {"type": "way", "id": 10, "tags": {"highway": "primary", "ref": "M1"}, "nodes": [7, 8],
             "geometry": [{"lat": -27.02, "lon": 153}, {"lat": -27.03, "lon": 153}]},
            {"type": "marker", "tags": {"name": "sites"}},
            {"type": "node", "id": 3, "lat": -27.05, "lon": 153.05, "tags": {"amenity": "school", "name": "X School"}},
        ]})
    }

    #[test]
    fn reads_the_presets_from_the_app() {
        let ps = presets(&app()).unwrap();
        assert!(ps.len() > 40);
        assert!(ps.iter().any(|p| p.id == "lismore"));
    }

    #[test]
    fn compact_keeps_buildings_flags_shared_road_nodes_and_sites() {
        let d = compact(&osm(), "x", &[0.0, 0.0, 1.0, 1.0]);
        assert_eq!(d["f"], json!([1, 2]));
        assert_eq!(d["nodes"].as_array().unwrap().len() / 2, 4, "the node shared by both roads is stored once");
        assert_eq!(d["roads"][1], json!(["M1", "primary", [2, 3]]));
        assert_eq!(d["sites"][0][0], "X School");
        assert_eq!(d["sites"][0][1], "School");
    }

    #[test]
    fn refreshes_missing_first_and_survives_a_dead_service() {
        let d = std::env::temp_dir().join(format!("osm-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        write_json(d.join("lismore.json"), &compact(&osm(), "lismore", &[0.0, 0.0, 1.0, 1.0])).unwrap();
        run(&app(), d.to_str().unwrap(), 3, 30.0, 1500.0, &|_: &str| -> R<Value> { Err("down".into()) }, &|_| {}).unwrap();
        let idx = read_json(d.join("index.json")).unwrap();
        assert_eq!(idx.as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect::<Vec<_>>(), ["lismore"]);
        let _ = std::fs::remove_dir_all(d);
    }
}
