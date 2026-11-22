//! Score a modelled flood extent against a reference flood outline.
//!
//! Usage: flood extent-skill <model_depth.tif> <outline.geojson> [--thresholds 0.05,0.1,0.3] [--margin 500] [--out report.json]
//!
//! The model is a depth GeoTIFF in metres (the viewer's GeoTIFF download, or any depth grid with a
//! projected or geographic CRS). The reference is a GeoJSON Polygon, MultiPolygon, Feature or
//! FeatureCollection in longitude and latitude (what an ArcGIS service returns with `f=geojson`).
//!
//! A cell is wet in the model when its depth reaches a threshold, and wet in the reference when its centre
//! is inside the outline. Cells with no model value are left out, never counted dry. Only cells inside the
//! outline's bounding box plus a margin are scored, so a large model area does not drown the score in
//! correct dry cells or in water the outline does not map (rivers, lakes). The report gives, for each
//! threshold, hits, misses and false alarms with their areas, the critical success index, the share of the
//! reference the model captured, the share of the model's water outside the reference, and the area ratio.

use crate::geo::{read_geotiff, rasterize, Proj, Raster};
use crate::util::R;
use serde_json::{json, Value};

pub struct Options {
    pub thresholds: Vec<f64>,
    pub margin_m: f64,
}
impl Default for Options {
    fn default() -> Self { Options { thresholds: vec![0.05, 0.1, 0.3], margin_m: 500.0 } }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Score {
    pub threshold: f64,
    pub hit: u64,
    pub miss: u64,
    pub fa: u64,
    pub dry: u64,
    pub unknown_in_reference: u64,
}
impl Score {
    pub fn csi(&self) -> f64 { ratio(self.hit, self.hit + self.miss + self.fa) }
    /// Share of the reference's cells the model wets (probability of detection).
    pub fn captured(&self) -> f64 { ratio(self.hit, self.hit + self.miss) }
    /// Share of the model's wet cells that are outside the reference (false alarm ratio).
    pub fn extra(&self) -> f64 { ratio(self.fa, self.hit + self.fa) }
    /// Modelled wet area over reference area; above 1 over-predicts.
    pub fn area_ratio(&self) -> f64 { ratio(self.hit + self.fa, self.hit + self.miss) }
}
fn ratio(a: u64, b: u64) -> f64 { if b == 0 { f64::NAN } else { a as f64 / b as f64 } }

/// Every ring of a GeoJSON value as (lon, lat) points: Polygon and MultiPolygon, alone or in Features.
pub fn geojson_rings(v: &Value) -> R<Vec<Vec<(f64, f64)>>> {
    fn ring(r: &Value) -> R<Vec<(f64, f64)>> {
        r.as_array().ok_or("a ring must be an array of positions")?.iter().map(|p| {
            let p = p.as_array().ok_or("a position must be an array")?;
            match (p.first().and_then(Value::as_f64), p.get(1).and_then(Value::as_f64)) {
                (Some(x), Some(y)) => Ok((x, y)),
                _ => Err("a position needs two numbers".to_string()),
            }
        }).collect()
    }
    fn walk(v: &Value, out: &mut Vec<Vec<(f64, f64)>>) -> R<()> {
        match v["type"].as_str() {
            Some("FeatureCollection") => for f in v["features"].as_array().ok_or("a FeatureCollection needs \"features\"")? { walk(f, out)?; },
            Some("Feature") => if !v["geometry"].is_null() { walk(&v["geometry"], out)?; },
            Some("GeometryCollection") => for g in v["geometries"].as_array().ok_or("a GeometryCollection needs \"geometries\"")? { walk(g, out)?; },
            Some("Polygon") => for r in v["coordinates"].as_array().ok_or("a Polygon needs \"coordinates\"")? { out.push(ring(r)?); },
            Some("MultiPolygon") => for p in v["coordinates"].as_array().ok_or("a MultiPolygon needs \"coordinates\"")? {
                for r in p.as_array().ok_or("a polygon must be an array of rings")? { out.push(ring(r)?); }
            },
            // points, lines and null geometries carry no area
            Some(_) | None => {}
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(v, &mut out)?;
    out.retain(|r| r.len() >= 3);
    if out.is_empty() { return Err("the outline has no polygons".into()); }
    Ok(out)
}

/// Metres per map unit east and north at a place: 1 and 1 for a metre grid, degrees scaled by the latitude,
/// and Web Mercator's stretch.
pub fn metres_per_unit(proj: &Proj, x: f64, y: f64) -> (f64, f64) {
    match proj {
        Proj::Geographic => { let (_, lat) = proj.to_lonlat(x, y); (111_320.0 * lat.to_radians().cos(), 111_320.0) }
        Proj::WebMercator => { let (_, lat) = proj.to_lonlat(x, y); let k = lat.to_radians().cos(); (k, k) }
        _ => (1.0, 1.0),
    }
}

/// Score a depth raster against rings given in the raster's own coordinates. `m_per_unit` is metres per map
/// unit east and north, used for the margin.
pub fn score(model: &Raster, rings: &[Vec<(f64, f64)>], m_per_unit: (f64, f64), o: &Options) -> R<Vec<Score>> {
    // burn in pixel space (x to the right, y down) so cells need not be square, as in degrees
    let px: Vec<Vec<(f64, f64)>> = rings.iter().map(|r| r.iter().map(|&(x, y)| ((x - model.x0) / model.dx, -(model.y0 - y) / model.dy)).collect()).collect();
    let mut reference = vec![0u8; model.w * model.h];
    rasterize(&mut reference, model.w, model.h, 0.0, 0.0, 1.0, &px, 1);
    // the scored window: the outline's bounding box plus the margin
    let (mut xmin, mut xmax, mut ymin, mut ymax) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for p in rings.iter().flatten() { xmin = xmin.min(p.0); xmax = xmax.max(p.0); ymin = ymin.min(p.1); ymax = ymax.max(p.1); }
    let (mx, my) = (o.margin_m / m_per_unit.0, o.margin_m / m_per_unit.1);
    let (xmin, xmax, ymin, ymax) = (xmin - mx, xmax + mx, ymin - my, ymax + my);
    let mut scores: Vec<Score> = o.thresholds.iter().map(|&t| Score { threshold: t, ..Default::default() }).collect();
    let mut any_overlap = false;
    for row in 0..model.h {
        let yc = model.y0 - (row as f64 + 0.5) * model.dy;
        if yc < ymin || yc > ymax { continue; }
        for col in 0..model.w {
            let xc = model.x0 + (col as f64 + 0.5) * model.dx;
            if xc < xmin || xc > xmax { continue; }
            let in_ref = reference[row * model.w + col] == 1;
            let d = model.get(col, row);
            if model.is_nodata(d) {
                if in_ref { for s in &mut scores { s.unknown_in_reference += 1; } }
                continue;
            }
            any_overlap = true;
            for s in &mut scores {
                match (d >= s.threshold, in_ref) {
                    (true, true) => s.hit += 1,
                    (false, true) => s.miss += 1,
                    (true, false) => s.fa += 1,
                    (false, false) => s.dry += 1,
                }
            }
        }
    }
    if !any_overlap { return Err("the outline and the model grid do not overlap (check the model's CRS and the outline's coordinates)".into()); }
    Ok(scores)
}

fn num_or_null(v: f64) -> Value { if v.is_finite() { json!((v * 1e4).round() / 1e4) } else { Value::Null } }

pub fn report_json(model: &Raster, cell_km2: f64, rings: usize, scores: &[Score], o: &Options) -> Value {
    let km2 = cell_km2;
    json!({
        "grid": { "w": model.w, "h": model.h, "cellAreaM2": (cell_km2 * 1e8).round() / 100.0, "epsg": model.epsg },
        "outlineRings": rings, "marginM": o.margin_m,
        "thresholds": scores.iter().map(|s| json!({
            "depthM": s.threshold,
            "hitKm2": num_or_null(s.hit as f64 * km2), "missKm2": num_or_null(s.miss as f64 * km2), "falseAlarmKm2": num_or_null(s.fa as f64 * km2),
            "csi": num_or_null(s.csi()), "captured": num_or_null(s.captured()), "extra": num_or_null(s.extra()), "areaRatio": num_or_null(s.area_ratio()),
            "referenceCellsWithoutModelValue": s.unknown_in_reference,
        })).collect::<Vec<_>>(),
    })
}

pub fn summary(cell_km2: f64, scores: &[Score]) -> String {
    let km2 = cell_km2;
    let mut out = format!("Flood extent against the reference outline ({:.1} m cells)\n", (cell_km2 * 1e6).sqrt());
    out += "depth   CSI   captured  extra  area ratio   hit km2  miss km2  false alarm km2\n";
    for s in scores {
        out += &format!("{:>5.2} m {:>5.2} {:>8.2} {:>7.2} {:>10.2} {:>9.2} {:>9.2} {:>16.2}\n", s.threshold, s.csi(), s.captured(), s.extra(), s.area_ratio(), s.hit as f64 * km2, s.miss as f64 * km2, s.fa as f64 * km2);
    }
    if scores.iter().any(|s| s.unknown_in_reference > 0) { out += &format!("{} reference cells have no model value and are not scored.\n", scores[0].unknown_in_reference); }
    out
}

pub fn run(model_path: &str, outline_path: &str, o: &Options, out: Option<&str>) -> R<String> {
    if o.thresholds.is_empty() || o.thresholds.iter().any(|t| !t.is_finite() || *t < 0.0) { return Err("thresholds must be depths of zero or more".into()); }
    let model = read_geotiff(&std::fs::read(model_path).map_err(|e| format!("{model_path}: {e}"))?)?;
    let proj = match model.epsg { Some(c) => Proj::from_epsg(c).ok_or(format!("the model's CRS (EPSG:{c}) is not supported"))?, None => return Err("the model GeoTIFF has no CRS".into()) };
    let gj: Value = serde_json::from_slice(&std::fs::read(outline_path).map_err(|e| format!("{outline_path}: {e}"))?).map_err(|e| format!("{outline_path}: {e}"))?;
    let rings: Vec<Vec<(f64, f64)>> = geojson_rings(&gj)?.into_iter().map(|r| r.into_iter().map(|(lon, lat)| proj.project_lonlat(lon, lat)).collect()).collect();
    let (cx, cy) = { let all: Vec<_> = rings.iter().flatten().collect(); (all.iter().map(|p| p.0).sum::<f64>() / all.len() as f64, all.iter().map(|p| p.1).sum::<f64>() / all.len() as f64) };
    let m = metres_per_unit(&proj, cx, cy);
    let scores = score(&model, &rings, m, o)?;
    let cell_km2 = (model.dx * m.0) * (model.dy * m.1) / 1e6;
    if let Some(p) = out { std::fs::write(p, serde_json::to_string_pretty(&report_json(&model, cell_km2, rings.len(), &scores, o)).unwrap()).map_err(|e| format!("{p}: {e}"))?; }
    Ok(summary(cell_km2, &scores))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(w: usize, h: usize, f: impl Fn(usize, usize) -> f64) -> Raster {
        let mut data = Vec::new();
        for r in 0..h { for c in 0..w { data.push(f(c, r)); } }
        Raster { w, h, data, nodata: Some(-9999.0), x0: 0.0, dx: 10.0, y0: 100.0, dy: 10.0, epsg: None }
    }
    // a square from x 20..60, y 30..70 (cells 4 wide by 4 high)
    fn square() -> Vec<Vec<(f64, f64)>> { vec![vec![(20.0, 30.0), (60.0, 30.0), (60.0, 70.0), (20.0, 70.0), (20.0, 30.0)]] }
    fn opts() -> Options { Options { thresholds: vec![0.1], margin_m: 0.0 } }
    fn in_square(c: usize, r: usize) -> bool { (2..6).contains(&c) && (3..7).contains(&r) }

    #[test]
    fn a_perfect_model_scores_one() {
        let s = &score(&grid(10, 10, |c, r| if in_square(c, r) { 1.0 } else { 0.0 }), &square(), (1.0, 1.0), &opts()).unwrap()[0];
        assert_eq!((s.hit, s.miss, s.fa), (16, 0, 0));
        assert_eq!((s.csi(), s.captured(), s.extra(), s.area_ratio()), (1.0, 1.0, 0.0, 1.0));
    }

    #[test]
    fn misses_and_false_alarms_are_counted_separately() {
        // wet on columns 4..8 of the same rows: half the square, and four columns of cells outside
        let o = Options { thresholds: vec![0.1], margin_m: 40.0 };
        let s = &score(&grid(10, 10, |c, r| if (4..8).contains(&c) && (3..7).contains(&r) { 1.0 } else { 0.0 }), &square(), (1.0, 1.0), &o).unwrap()[0];
        assert_eq!((s.hit, s.miss, s.fa), (8, 8, 8));
        assert!((s.csi() - 8.0 / 24.0).abs() < 1e-12 && s.captured() == 0.5 && s.extra() == 0.5 && s.area_ratio() == 1.0);
    }

    #[test]
    fn the_threshold_decides_what_is_wet() {
        let r = grid(10, 10, |c, r| if in_square(c, r) { 0.2 } else { 0.0 });
        let o = Options { thresholds: vec![0.1, 0.3], margin_m: 0.0 };
        let s = score(&r, &square(), (1.0, 1.0), &o).unwrap();
        assert_eq!((s[0].hit, s[0].miss), (16, 0));
        assert_eq!((s[1].hit, s[1].miss), (0, 16));
    }

    #[test]
    fn cells_without_a_model_value_are_never_counted_dry() {
        let r = grid(10, 10, |c, r| if c == 2 && in_square(c, r) { -9999.0 } else if in_square(c, r) { 1.0 } else { 0.0 });
        let s = &score(&r, &square(), (1.0, 1.0), &opts()).unwrap()[0];
        assert_eq!((s.hit, s.miss, s.unknown_in_reference), (12, 0, 4));
    }

    #[test]
    fn the_margin_limits_where_false_alarms_count() {
        let r = grid(10, 10, |_, _| 1.0);
        let tight = &score(&r, &square(), (1.0, 1.0), &opts()).unwrap()[0];
        let wide = &score(&r, &square(), (1.0, 1.0), &Options { thresholds: vec![0.1], margin_m: 20.0 }).unwrap()[0];
        assert_eq!((tight.hit, tight.fa), (16, 0));
        assert!(wide.fa > 0 && wide.hit == 16);
    }

    #[test]
    fn a_hole_in_the_outline_is_not_reference() {
        let mut rings = square();
        rings.push(vec![(30.0, 40.0), (50.0, 40.0), (50.0, 60.0), (30.0, 60.0), (30.0, 40.0)]); // a 2 x 2 cell hole
        let s = &score(&grid(10, 10, |c, r| if in_square(c, r) { 1.0 } else { 0.0 }), &rings, (1.0, 1.0), &opts()).unwrap()[0];
        assert_eq!((s.hit, s.fa), (12, 4));
    }

    #[test]
    fn a_grid_that_misses_the_outline_is_refused() {
        let far: Vec<Vec<(f64, f64)>> = vec![vec![(1e6, 1e6), (1e6 + 10.0, 1e6), (1e6, 1e6 + 10.0)]];
        assert!(score(&grid(10, 10, |_, _| 1.0), &far, (1.0, 1.0), &opts()).unwrap_err().contains("do not overlap"));
    }

    #[test]
    fn geojson_polygons_multipolygons_and_features_are_read() {
        let poly = json!({"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]],[[0.1,0.1],[0.2,0.1],[0.2,0.2],[0.1,0.1]]]});
        let multi = json!({"type":"MultiPolygon","coordinates":[[[[0,0],[1,0],[1,1],[0,0]]],[[[2,2],[3,2],[3,3],[2,2]]]]});
        let fc = json!({"type":"FeatureCollection","features":[{"type":"Feature","geometry":poly.clone()},{"type":"Feature","geometry":null},{"type":"Feature","geometry":multi.clone()}]});
        assert_eq!(geojson_rings(&poly).unwrap().len(), 2);
        assert_eq!(geojson_rings(&multi).unwrap().len(), 2);
        assert_eq!(geojson_rings(&fc).unwrap().len(), 4);
        assert!(geojson_rings(&json!({"type":"Point","coordinates":[0,0]})).is_err());
        assert!(geojson_rings(&json!({"type":"Polygon","coordinates":[[[0,0],[1,0]]]})).is_err());
    }

    #[test]
    fn cells_need_not_be_square() {
        // 10 m wide and 20 m high cells, as in degrees: the same outline covers 4 columns by 2 rows
        let mut r = grid(10, 10, |c, r| if (2..6).contains(&c) && (1..4).contains(&r) { 1.0 } else { 0.0 });
        r.dy = 20.0;
        let s = &score(&r, &square(), (1.0, 1.0), &opts()).unwrap()[0];
        assert_eq!(s.hit + s.miss, 8);
    }

    #[test]
    fn degrees_and_web_mercator_get_metres_per_unit() {
        let (mx, my) = metres_per_unit(&Proj::Geographic, 153.0, -27.5);
        assert!((my - 111_320.0).abs() < 1e-6 && (mx - 111_320.0 * 27.5f64.to_radians().cos()).abs() < 1e-6);
        assert_eq!(metres_per_unit(&Proj::from_epsg(7856).unwrap(), 5e5, 7e6), (1.0, 1.0));
        let (wx, wy) = metres_per_unit(&Proj::WebMercator, 0.0, 0.0);
        assert!((wx - 1.0).abs() < 1e-9 && wx == wy);
    }

    #[test]
    fn a_geotiff_and_a_lonlat_outline_are_scored_end_to_end() {
        use crate::geo::write_geotiff_f32;
        let dir = std::env::temp_dir().join(format!("extent-skill-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 20 x 20 cells of 10 m in GDA2020 / MGA zone 56 (EPSG:7856) near Brisbane; the middle 10 x 10 is wet
        let (x0, y0, cell, n) = (502000.0, 6962000.0, 10.0, 20usize);
        let depth: Vec<f32> = (0..n * n).map(|i| if (5..15).contains(&(i % n)) && (5..15).contains(&(i / n)) { 0.5 } else { 0.0 }).collect();
        let tif = dir.join("model.tif");
        write_geotiff_f32(&tif, n, n, &depth, x0, y0, cell, 7856, -9999.0).unwrap();
        // the outline is the same middle square, written in longitude and latitude
        let proj = Proj::from_epsg(7856).unwrap();
        let corner = |dx: f64, dy: f64| { let (lon, lat) = proj.to_lonlat(x0 + dx * cell, y0 - dy * cell); json!([lon, lat]) };
        let outline = json!({"type":"Polygon","coordinates":[[corner(5.0, 5.0), corner(15.0, 5.0), corner(15.0, 15.0), corner(5.0, 15.0), corner(5.0, 5.0)]]});
        let gj = dir.join("outline.geojson");
        std::fs::write(&gj, outline.to_string()).unwrap();
        let report = dir.join("report.json");
        let text = run(tif.to_str().unwrap(), gj.to_str().unwrap(), &Options { thresholds: vec![0.1], margin_m: 50.0 }, Some(report.to_str().unwrap())).unwrap();
        assert!(text.contains("1.00"), "{text}");
        let r: Value = serde_json::from_slice(&std::fs::read(&report).unwrap()).unwrap();
        assert_eq!(r["thresholds"][0]["csi"], json!(1.0));
        assert_eq!(r["thresholds"][0]["hitKm2"], json!(0.01));
        std::fs::remove_dir_all(&dir).ok();
    }
}
