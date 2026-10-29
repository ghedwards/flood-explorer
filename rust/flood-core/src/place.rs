//! Where a modelled tsunami place sits on the map, and how its run lands on an area model. A place is a W x H grid over an MGA extent ([xmin, ymin, xmax, ymax], row 0
//! the north edge). These are the geometry resolvers the tsunami panel uses: the lat/lon bounds of a place, the grid cell under a point, the cell under every pixel of a
//! canvas laid over it, and a run's extremes carried onto an area model's cells for the impact tools.

use crate::dam::{Area, AreaRun};
use crate::geo;

#[derive(Clone, Copy)]
pub struct Place { pub extent: [f64; 4], pub w: usize, pub h: usize, pub zone: i32 }

/// [south, west, north, east] of the place's four corners, degrees.
pub fn bounds(p: &Place) -> [f64; 4] {
    let [e0, n0, e1, n1] = p.extent;
    let (mut south, mut west, mut north, mut east) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (e, n) in [(e0, n0), (e1, n0), (e0, n1), (e1, n1)] {
        let (lat, lon) = geo::from_mga(e, n, p.zone);
        south = south.min(lat); north = north.max(lat); west = west.min(lon); east = east.max(lon);
    }
    [south, west, north, east]
}

fn cell_at(p: &Place, e: f64, n: f64) -> Option<usize> {
    let [e0, n0, e1, n1] = p.extent;
    if e < e0 || e >= e1 || n < n0 || n >= n1 { return None; }
    Some((((n1 - n) / (n1 - n0) * p.h as f64).floor() as usize) * p.w + ((e - e0) / (e1 - e0) * p.w as f64).floor() as usize)
}

/// The grid cell under a latitude and longitude, if it is inside the place.
pub fn cell_index(p: &Place, lat: f64, lon: f64) -> Option<usize> {
    let (e, n) = geo::to_mga(lat, lon, p.zone);
    cell_at(p, e, n)
}

/// For each pixel of a `width` x `height` canvas laid over `[south, west, north, east]` (row 0 the north edge), the index of the grid cell under it, or -1 outside the place.
pub fn pixel_map(p: &Place, over: [f64; 4], width: usize, height: usize) -> Vec<i32> {
    let [south, west, north, east] = over;
    let mut out = vec![-1i32; width * height];
    for py in 0..height {
        let lat = north - (py as f64 + 0.5) / height as f64 * (north - south);
        for px in 0..width {
            let (e, n) = geo::to_mga(lat, west + (px as f64 + 0.5) / width as f64 * (east - west), p.zone);
            if let Some(c) = cell_at(p, e, n) { out[py * width + px] = c as i32; }
        }
    }
    out
}

/// What a tsunami run saw at its worst on the place's grid, per cell: the deepest water (land) or highest wave (sea), the worst hazard class and fastest speed, and the seconds
/// until the water first stood 10 cm up (negative or NaN where it did not). `land[c]` is 1 where the ground is dry at mean sea level.
pub struct Derived<'a> { pub land: &'a [u8], pub peak: &'a [f64], pub arrival: &'a [f64], pub class: &'a [u8], pub speed: &'a [f64] }

/// Carry a run onto an area model (`geo` is its [west, south, east, north]): each land cell's deepest water (the tide's own cover included, as in the run's summary), worst
/// hazard class and speed, and arrival. The sea and the area's own ocean cells stay dry. `covered` counts the area's cells inside the place.
pub fn run_on_area(area: &Area, over: [f64; 4], p: &Place, d: &Derived) -> AreaRun {
    let n = area.w * area.h;
    let mut run = AreaRun { depth: vec![0.0; n], wet: vec![0; n], level: vec![f32::NAN; n], arrival: vec![f32::NAN; n], class: vec![0; n], speed: vec![0.0; n], km2: [0.0; 6], covered: 0, edge: false };
    let [south, west, north, east] = bounds(p);
    let [gw, gs, ge, gn] = over;
    // only the area cells that can be inside the place are looked up
    let x0 = (((west - gw) / (ge - gw) * area.w as f64).floor().max(0.0)) as usize;
    let x1 = (((east - gw) / (ge - gw) * area.w as f64).ceil().min(area.w as f64 - 1.0)).max(0.0) as usize;
    let y0 = (((gn - north) / (gn - gs) * area.h as f64).floor().max(0.0)) as usize;
    let y1 = (((gn - south) / (gn - gs) * area.h as f64).ceil().min(area.h as f64 - 1.0)).max(0.0) as usize;
    for y in y0..=y1 {
        let lat = gn - (y as f64 + 0.5) / area.h as f64 * (gn - gs);
        for x in x0..=x1 {
            let i = y * area.w + x;
            if (!area.valid.is_empty() && area.valid[i] == 0) || (!area.ocean.is_empty() && area.ocean[i] != 0) { continue; }
            let Some(c) = cell_index(p, lat, gw + (x as f64 + 0.5) / area.w as f64 * (ge - gw)) else { continue };
            run.covered += 1;
            if d.land[c] == 0 { continue; }
            let depth = d.peak[c];
            if depth.is_nan() || depth <= 0.0 { continue; }
            run.depth[i] = depth as f32;
            run.wet[i] = u8::from(depth >= 0.01);
            run.level[i] = (area.dem[i] + depth) as f32;
            if d.arrival[c] >= 0.0 { run.arrival[i] = d.arrival[c] as f32; }
            run.class[i] = if depth >= 0.01 { d.class[c].max(1) } else { 0 };
            run.speed[i] = d.speed[c] as f32;
        }
    }
    let cell_km2 = area.cell * area.cell / 1e6;
    for c in &run.class { if *c > 0 { run.km2[*c as usize - 1] += cell_km2; } }
    run
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLACE: Place = Place { extent: [537500.0, 6905500.0, 545500.0, 6910300.0], w: 4, h: 2, zone: 56 };

    #[test]
    fn a_point_finds_its_cell_north_at_the_top_and_outside_is_none() {
        // the place is 8 km by 4.8 km, 4 by 2 cells
        let (lat, lon) = geo::from_mga(537500.0 + 1000.0, 6905500.0 + 4800.0 - 1200.0, 56);
        assert_eq!(cell_index(&PLACE, lat, lon), Some(0));
        let (lat, lon) = geo::from_mga(537500.0 + 7000.0, 6905500.0 + 1200.0, 56);
        assert_eq!(cell_index(&PLACE, lat, lon), Some(7));
        assert_eq!(cell_index(&PLACE, -10.0, 150.0), None);
        let b = bounds(&PLACE);
        assert!(b[0] < b[2] && b[1] < b[3] && b[0] > -29.0 && b[0] < -27.0, "{b:?}");
    }

    #[test]
    fn each_pixel_maps_to_the_cell_under_it() {
        let b = bounds(&PLACE);
        let (width, height) = (16, 10);
        let map = pixel_map(&PLACE, b, width, height);
        assert_eq!(map.len(), width * height);
        assert_eq!(map[0], 0, "the north-west pixel is cell 0");
        assert_eq!(map[width - 1], 3, "the north-east pixel is the last cell of the first row");
        assert_eq!(map[(height - 1) * width], 4, "the south-west pixel is the first cell of the second row");
        assert_eq!(map[map.len() - 1], 7);
        assert!(map.iter().all(|c| *c >= -1 && *c < 8));
        // a canvas twice as wide has outside pixels at its edges
        let wide = [b[0], b[1] - (b[3] - b[1]) / 2.0, b[2], b[3] + (b[3] - b[1]) / 2.0];
        let outside = pixel_map(&PLACE, wide, 32, 10);
        assert_eq!(outside[0], -1);
        assert!(outside.iter().any(|c| *c >= 0));
    }

    #[test]
    fn a_run_is_carried_onto_an_area_model_cell_by_cell() {
        let b = bounds(&PLACE);
        // an area twice the place's width and height with the place in its middle: 16 by 8 cells, two area cells to a place cell
        let (dw, dh) = (b[3] - b[1], b[2] - b[0]);
        let over = [b[1] - dw / 2.0, b[0] - dh / 2.0, b[3] + dw / 2.0, b[2] + dh / 2.0];
        let mut ocean = vec![0u8; 128];
        ocean[5 * 16 + 8] = 1;
        let area = Area { w: 16, h: 8, cell: 100.0, dem: vec![2.0; 128], valid: vec![1; 128], ocean };
        let land = [1u8, 1, 0, 1, 1, 1, 1, 1];
        let peak = [0.5, 2.0, 0.4, 0.0, 1.0, 1.0, 1.0, 1.0];
        let arrival = [120.0, 900.0, f64::NAN, f64::NAN, 60.0, 60.0, 60.0, 60.0];
        let class = [3u8, 6, 0, 0, 2, 2, 2, 2];
        let speed = [1.0, 4.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.5];
        let run = run_on_area(&area, over, &PLACE, &Derived { land: &land, peak: &peak, arrival: &arrival, class: &class, speed: &speed });
        let at = |lat: f64, lon: f64| {
            let x = ((lon - over[0]) / (over[2] - over[0]) * 16.0).floor() as usize;
            let y = ((over[3] - lat) / (over[3] - over[1]) * 8.0).floor() as usize;
            y * 16 + x
        };
        let (lat, lon) = geo::from_mga(537500.0 + 500.0, 6905500.0 + 4800.0 - 300.0, 56);
        let i0 = at(lat, lon);
        assert!((run.depth[i0] - 0.5).abs() < 1e-6 && run.wet[i0] == 1 && run.arrival[i0] == 120.0 && (run.level[i0] - 2.5).abs() < 1e-5);
        assert_eq!((run.class[i0], run.speed[i0]), (3, 1.0));
        let (lat, lon) = geo::from_mga(537500.0 + 4500.0, 6905500.0 + 4800.0 - 300.0, 56);
        assert_eq!(run.depth[at(lat, lon)], 0.0, "sea in the run stays dry");
        assert_eq!(run.depth[0], 0.0, "outside the place stays dry");
        assert_eq!(run.depth[5 * 16 + 8], 0.0, "the area model's own sea stays dry");
        assert!(run.covered > 0 && run.covered < 128);
        assert!(run.depth.iter().all(|d| *d >= 0.0) && run.arrival[0].is_nan());
        assert!(run.km2[2] > 0.0 && run.km2.iter().all(|k| *k >= 0.0));
    }
}
