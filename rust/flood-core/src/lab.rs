//! The numbers behind the wave lab page: picking an ocean cell near a spot, what a frame has flooded and its extremes, and the terrain heights and the colours the page paints
//! them with. Drawing itself stays on the page.

/// The grid cell `[x, y]` nearest `target` (straight-line distance in cells) whose ground is deeper than `min_depth` metres below zero, scanning in index order so ties keep the first.
pub fn water_point(elevation: &[f64], width: usize, target: (f64, f64), min_depth: f64) -> Option<(usize, usize)> {
    let (mut best, mut distance) = (None, f64::INFINITY);
    for (i, z) in elevation.iter().enumerate() {
        if *z < -min_depth {
            let (x, y) = (i % width, i / width);
            let d = (x as f64 - target.0).hypot(y as f64 - target.1);
            if d < distance { distance = d; best = Some((x, y)); }
        }
    }
    best
}

#[derive(Debug, PartialEq)]
pub struct FrameStats { pub flooded: usize, pub max_land_depth: f64, pub max_speed: f64, pub max_peak: f64 }

/// Land cells (`depth` 0) holding more than 1 cm of water, the deepest such water, and the largest speed and peak anywhere. Missing arrays count as zero.
pub fn frame_stats(depth: &[f64], water: &[f64], speed: &[f64], peak: &[f64]) -> FrameStats {
    let (mut flooded, mut max_land_depth) = (0, 0.0_f64);
    for (d, h) in depth.iter().zip(water) { if *d == 0.0 && *h > 0.01 { flooded += 1; max_land_depth = max_land_depth.max(*h); } }
    let largest = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().copied().fold(f64::NEG_INFINITY, f64::max) };
    FrameStats { flooded, max_land_depth, max_speed: largest(speed), max_peak: largest(peak) }
}

pub struct Terrain { pub elevation: Vec<f64>, pub low: f64, pub high: f64, pub colours: Vec<u8> }

/// Heights for display, independent of water depth and the solver's shallow-water floor (NaN where unknown, or where `valid` is 0), their range through zero, and an RGB colour for each:
/// shades of blue below zero and of green to brown above, grey where unknown.
pub fn terrain(elevation: Vec<f64>, valid: Option<&[u8]>) -> Terrain {
    let mut elevation = elevation;
    if let Some(valid) = valid { for (z, v) in elevation.iter_mut().zip(valid) { if *v == 0 { *z = f64::NAN; } } }
    let (mut low, mut high) = (0.0_f64, 0.0_f64);
    for z in elevation.iter().filter(|z| z.is_finite()) { low = low.min(*z); high = high.max(*z); }
    let mut colours = Vec::with_capacity(elevation.len() * 3);
    for z in &elevation {
        let rgb = if z.is_finite() {
            let (a, b, fraction) = if *z < 0.0 { ([164.0, 214.0, 225.0], [17.0, 54.0, 94.0], z / if low != 0.0 { low } else { -1.0 }) } else { ([139.0, 178.0, 115.0], [185.0, 145.0, 96.0], z / if high != 0.0 { high } else { 1.0 }) };
            [0, 1, 2].map(|k| js_round(a[k] + (b[k] - a[k]) * fraction))
        } else { [110, 119, 107] };
        colours.extend(rgb);
    }
    Terrain { elevation, low, high, colours }
}

// Math.round: halves go up
fn js_round(v: f64) -> u8 { (v + 0.5).floor().clamp(0.0, 255.0) as u8 }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nearest_deep_enough_cell_is_found_and_ties_keep_the_first() {
        let mut z = vec![10.0; 16];
        assert_eq!(water_point(&z, 4, (1.0, 1.0), 5.0), None);
        z[0] = -100.0; z[15] = -100.0; z[6] = -2.0;
        assert_eq!(water_point(&z, 4, (3.0, 3.0), 5.0), Some((3, 3)));
        assert_eq!(water_point(&z, 4, (1.0, 1.0), 1.0), Some((2, 1)), "a shallow cell counts when the minimum depth allows it");
        assert_eq!(water_point(&z, 4, (1.5, 1.5), 5.0), Some((0, 0)), "equidistant cells: the first in index order");
    }

    #[test]
    fn a_frame_is_summarised_over_its_land_and_its_extremes() {
        let s = frame_stats(&[0.0, 0.0, 5.0, 0.0], &[0.5, 0.005, 3.0, 1.25], &[0.1, 2.0, 0.3, 0.0], &[1.0, 2.0, 9.0, 0.0]);
        assert_eq!(s, FrameStats { flooded: 2, max_land_depth: 1.25, max_speed: 2.0, max_peak: 9.0 });
        assert_eq!(frame_stats(&[0.0], &[0.0], &[], &[]), FrameStats { flooded: 0, max_land_depth: 0.0, max_speed: 0.0, max_peak: 0.0 });
    }

    #[test]
    fn terrain_colours_run_from_shallow_to_deep_and_low_to_high_and_unknown_is_grey() {
        let t = terrain(vec![-10.0, 0.0, 20.0, f64::NAN, 5.0], Some(&[1, 1, 1, 1, 0]));
        assert_eq!((t.low, t.high), (-10.0, 20.0));
        assert_eq!(&t.colours[0..3], &[17, 54, 94], "the deepest ground is the deep colour");
        assert_eq!(&t.colours[3..6], &[139, 178, 115], "zero is the start of the land ramp");
        assert_eq!(&t.colours[6..9], &[185, 145, 96]);
        assert_eq!(&t.colours[9..12], &[110, 119, 107]);
        assert_eq!(&t.colours[12..15], &[110, 119, 107], "ground marked invalid is unknown");
        assert!(t.elevation[4].is_nan());
        let flat = terrain(vec![0.0, 0.0], None);
        assert_eq!((flat.low, flat.high), (0.0, 0.0));
    }
}
