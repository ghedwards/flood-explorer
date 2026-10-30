//! The intermediate grid of a three-level nest (regional, intermediate, local): the local scene's terrain block-averaged to the intermediate cell size, and around it the
//! regional model's depths, so the wave meets the shelf and the coast in steps of about six rather than thirty. It covers the local scene plus a margin on every side and is
//! laid out on the same axes (north up, MGA metres), which is also how the local model is placed in it.
//!
//! This is not new bathymetry: outside the local scene the depths are the regional ones read smoothly (bilinear over wet cells), so the gain is the finer representation of the
//! coast and of the wave's path, not finer data. The seam where the local terrain begins can show a step if the two sources disagree about the sea floor.

use crate::geo;

/// The local scene's terrain: `bed` (m, negative below sea level) on a `w` x `h` grid of `cell` m, row 0 the north edge, laid over `extent` = [xmin, ymin, xmax, ymax] in MGA metres.
pub struct LocalTerrain<'a> { pub w: usize, pub h: usize, pub cell: f64, pub extent: [f64; 4], pub bed: &'a [f64], pub valid: Option<&'a [u8]> }

/// The regional model's still-water depths (0 on land) on an evenly spaced longitude/latitude grid: `bounds` = [west, south, east, north].
pub struct RegionalDepths<'a> { pub w: usize, pub h: usize, pub bounds: [f64; 4], pub depth: &'a [f64] }

#[derive(Debug)]
pub struct Mid { pub w: usize, pub h: usize, pub cell: f64, pub extent: [f64; 4], pub bed: Vec<f64>, pub reference: Vec<f64> }

/// Ground height given to land that only the regional model knows, which has no heights: a wall a few metres high.
pub const REGIONAL_LAND: f64 = 5.0;

pub fn intermediate(local: &LocalTerrain, regional: &RegionalDepths, zone: i32, cell: f64, margin: f64) -> Result<Mid, String> {
    let [lx0, ly0, lx1, ly1] = local.extent;
    if !(cell.is_finite() && cell >= 20.0) || !(margin.is_finite() && margin >= 0.0) { return Err("invalid intermediate grid settings".into()); }
    if !(lx1 > lx0 && ly1 > ly0) || local.bed.len() != local.w * local.h || local.valid.is_some_and(|v| v.len() != local.bed.len()) { return Err("invalid local terrain for the intermediate grid".into()); }
    let [west, south, east, north] = regional.bounds;
    if !(east > west && north > south) || regional.depth.len() != regional.w * regional.h || regional.w < 2 || regional.h < 2 { return Err("invalid regional depths for the intermediate grid".into()); }
    let nx = ((lx1 - lx0 + 2.0 * margin) / cell).ceil() as usize;
    let ny = ((ly1 - ly0 + 2.0 * margin) / cell).ceil() as usize;
    if nx > 512 || ny > 512 { return Err(format!("the intermediate grid would be {nx} x {ny} cells (at most 512): use a larger cell or a smaller margin")); }
    // centred on the local scene
    let (x0, y1) = (lx0 - (nx as f64 * cell - (lx1 - lx0)) / 2.0, ly1 + (ny as f64 * cell - (ly1 - ly0)) / 2.0);
    let (mut bed, mut reference) = (vec![0.0; nx * ny], vec![0.0; nx * ny]);
    for j in 0..ny { for i in 0..nx {
        let (ax, ay) = (x0 + i as f64 * cell, y1 - (j + 1) as f64 * cell);   // the footprint's south-west corner
        let inside = ax >= lx0 && ax + cell <= lx1 && ay >= ly0 && ay + cell <= ly1;
        let mut value = None;
        if inside {
            let (mut sum, mut n) = (0.0, 0usize);
            let (c0, c1) = (((ax - lx0) / local.cell).floor().max(0.0) as usize, ((ax + cell - lx0) / local.cell).ceil() as usize);
            let (r0, r1) = (((ly1 - ay - cell) / local.cell).floor().max(0.0) as usize, ((ly1 - ay) / local.cell).ceil() as usize);
            for r in r0..r1.min(local.h) { for c in c0..c1.min(local.w) {
                let (cx, cy) = (lx0 + (c as f64 + 0.5) * local.cell, ly1 - (r as f64 + 0.5) * local.cell);
                if cx < ax || cx >= ax + cell || cy < ay || cy >= ay + cell { continue; }
                let k = r * local.w + c;
                if local.valid.is_some_and(|v| v[k] == 0) || !local.bed[k].is_finite() { continue; }
                sum += local.bed[k]; n += 1;
            } }
            if n > 0 { value = Some(sum / n as f64); }
        }
        let z = value.unwrap_or_else(|| {
            let (lat, lon) = geo::from_mga(ax + cell / 2.0, ay + cell / 2.0, zone);
            let px = ((lon - west) / (east - west) * regional.w as f64).clamp(0.5, regional.w as f64 - 0.5) - 0.5;
            let py = ((north - lat) / (north - south) * regional.h as f64).clamp(0.5, regional.h as f64 - 0.5) - 0.5;
            let (x, y, tx, ty) = (px.floor() as usize, py.floor() as usize, px.fract(), py.fract());
            let (mut wet, mut total) = (0.0, 0.0);
            for (dx, dy, weight) in [(0, 0, (1.0 - tx) * (1.0 - ty)), (1, 0, tx * (1.0 - ty)), (0, 1, (1.0 - tx) * ty), (1, 1, tx * ty)] {
                let d = regional.depth[(y + dy).min(regional.h - 1) * regional.w + (x + dx).min(regional.w - 1)];
                if d > 0.0 { wet += weight; total += weight * d; }
            }
            if wet >= 0.5 { -(total / wet) } else { REGIONAL_LAND }
        });
        bed[j * nx + i] = z;
        reference[j * nx + i] = (-z).max(0.0);
    } }
    Ok(Mid { w: nx, h: ny, cell, extent: [x0, y1 - ny as f64 * cell, x0 + nx as f64 * cell, y1], bed, reference })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_intermediate_grid_averages_the_local_terrain_and_reads_the_regional_sea_around_it() {
        // local: 8 x 8 cells of 100 m, west half 20 m deep, east half 10 m high; at MGA 500,000 E, 6,900,000 N (zone 56)
        let bed: Vec<f64> = (0..64).map(|i| if i % 8 < 4 { -20.0 } else { 10.0 }).collect();
        let local = LocalTerrain { w: 8, h: 8, cell: 100.0, extent: [500000.0, 6899200.0, 500800.0, 6900000.0], bed: &bed, valid: None };
        // regional: 20 x 20 cells over a degree, all 50 m deep except a land strip along the north
        let depth: Vec<f64> = (0..400).map(|i| if i / 20 < 2 { 0.0 } else { 50.0 }).collect();
        let (lat, lon) = geo::from_mga(500400.0, 6899600.0, 56);
        let regional = RegionalDepths { w: 20, h: 20, bounds: [lon - 0.5, lat - 0.5, lon + 0.5, lat + 0.5], depth: &depth };
        let mid = intermediate(&local, &regional, 56, 200.0, 400.0).unwrap();
        assert_eq!((mid.w, mid.h), (8, 8), "800 m of local scene plus 400 m each side, in 200 m cells");
        let at = |x: usize, y: usize| mid.bed[y * mid.w + x];
        // the margin is the regional sea, 50 m deep
        assert!((at(0, 0) + 50.0).abs() < 1.0 && (at(7, 7) + 50.0).abs() < 1.0);
        // inside the local scene: 2 cells of 200 m each way; the west two columns average -20, the east two +10
        assert!((at(2, 3) + 20.0).abs() < 1e-9 && (at(3, 3) + 20.0).abs() < 1e-9 && (at(4, 3) - 10.0).abs() < 1e-9 && (at(5, 3) - 10.0).abs() < 1e-9);
        assert!(mid.reference[3 * 8 + 2] == 20.0 && mid.reference[3 * 8 + 4] == 0.0);
        // the grid sits where it says: the local scene is the middle of it
        assert!((mid.extent[0] - 499600.0).abs() < 1e-9 && (mid.extent[3] - 6900400.0).abs() < 1e-9);
    }

    #[test]
    fn unusable_inputs_and_oversize_grids_are_refused() {
        let bed = vec![-10.0; 16];
        let local = LocalTerrain { w: 4, h: 4, cell: 50.0, extent: [0.0, 0.0, 200.0, 200.0], bed: &bed, valid: None };
        let depth = vec![10.0; 16];
        let regional = RegionalDepths { w: 4, h: 4, bounds: [150.0, -28.0, 151.0, -27.0], depth: &depth };
        assert!(intermediate(&local, &regional, 56, 10.0, 0.0).is_err());
        assert!(intermediate(&local, &regional, 56, 100.0, f64::NAN).is_err());
        assert!(intermediate(&local, &regional, 56, 20.0, 100000.0).unwrap_err().contains("at most 512"));
        assert!(intermediate(&LocalTerrain { bed: &bed[..8], ..local }, &regional, 56, 100.0, 100.0).is_err());
    }
}
