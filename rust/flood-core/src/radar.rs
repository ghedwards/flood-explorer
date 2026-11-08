//! Radar rain rates onto the 2D solver's grid, whatever the radar source.
//!
//! A source (a broker endpoint, an image tile service, an archive) hands over frames of rain rate
//! (mm/h) on a regular north-up grid in the same metric coordinates as the model area. This module
//! resamples them to the solver's cells and turns an equally spaced run of observed frames into a
//! [`RainField`]. It never turns missing data into "no rain": a frame that does not cover the area
//! or holds a gap is refused, and the caller says so.
use crate::rainfield::RainField;
use crate::flash::MAX_RATE;

/// Where a radar frame sits: `w` x `h` cells of `dx` x `dy` metres, the top-left corner at
/// (`x0`, `y0`), x growing east and y growing south from `y0` (north-up images).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RadarGrid { pub w: usize, pub h: usize, pub x0: f64, pub y0: f64, pub dx: f64, pub dy: f64 }

/// The solver's grid in the same coordinates: the top-left corner and the cell size.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TargetGrid { pub w: usize, pub h: usize, pub x0: f64, pub y0: f64, pub cell: f64 }

impl RadarGrid {
    fn check(&self, data: &[f32]) -> Result<(), String> {
        if self.w < 2 || self.h < 2 || !(self.dx.is_finite() && self.dx > 0.0 && self.dy.is_finite() && self.dy > 0.0 && self.x0.is_finite() && self.y0.is_finite()) {
            return Err("radar grid needs at least 2 x 2 cells and a positive cell size".into());
        }
        if data.len() != self.w * self.h { return Err(format!("radar frame has {} values for {} cells", data.len(), self.w * self.h)); }
        Ok(())
    }
    /// Bilinear value at a point, NaN outside the span of the cell centres or where a neighbour is NaN.
    pub(crate) fn sample(&self, data: &[f32], x: f64, y: f64) -> f32 {
        let (fx, fy) = ((x - self.x0) / self.dx - 0.5, (y - self.y0) / self.dy - 0.5);
        if !(fx >= 0.0 && fy >= 0.0 && fx <= (self.w - 1) as f64 && fy <= (self.h - 1) as f64) { return f32::NAN; }
        let (i, j) = ((fx.floor() as usize).min(self.w - 2), (fy.floor() as usize).min(self.h - 2));
        let (tx, ty) = (fx - i as f64, fy - j as f64);
        let v = |a: usize, b: usize| data[b * self.w + a] as f64;
        let r = v(i, j) * (1.0 - tx) * (1.0 - ty) + v(i + 1, j) * tx * (1.0 - ty) + v(i, j + 1) * (1.0 - tx) * ty + v(i + 1, j + 1) * tx * ty;
        r as f32
    }
}

/// Resample one radar frame (mm/h) to the solver's cells, bilinear at each cell's centre. Returns the
/// rates and the share of cells the radar covered with real values. Cells it did not cover are NaN.
pub fn resample(radar: &RadarGrid, data: &[f32], target: &TargetGrid) -> Result<(Vec<f32>, f64), String> {
    if target.w == 0 || target.h == 0 || !(target.cell.is_finite() && target.cell > 0.0 && target.x0.is_finite() && target.y0.is_finite()) {
        return Err("target grid needs cells and a positive cell size".into());
    }
    resample_points(radar, data, &target.points())
}

impl TargetGrid {
    /// The centre of every cell, row by row, in the radar's coordinates.
    pub fn points(&self) -> Vec<(f64, f64)> {
        (0..self.h).flat_map(|j| (0..self.w).map(move |i| (self.x0 + (i as f64 + 0.5) * self.cell, self.y0 + (j as f64 + 0.5) * self.cell))).collect()
    }
}

/// Resample one radar frame (mm/h) at arbitrary points (a solver grid that is not axis-aligned with the
/// radar, say), bilinear. Returns one value per point (NaN outside the radar) and the covered share.
pub fn resample_points(radar: &RadarGrid, data: &[f32], points: &[(f64, f64)]) -> Result<(Vec<f32>, f64), String> {
    radar.check(data)?;
    if points.is_empty() { return Err("no points to sample".into()); }
    let out: Vec<f32> = points.iter().map(|(x, y)| radar.sample(data, *x, *y)).collect();
    let covered = out.iter().filter(|v| v.is_finite()).count();
    Ok((out, covered as f64 / points.len() as f64))
}

/// Turn equally spaced observed radar frames into the rain field the solver takes (before losses).
///
/// Every frame must be the radar grid's size, hold no NaN over the area, and cover at least
/// `min_coverage` of the solver's cells (0 to 1); rates are clamped to 0 to 1000 mm/h (a slightly
/// negative value from interpolation counts as 0). Each frame holds for `step_s`, so frame k is the
/// rain from k x `step_s` after the first frame's start; pass frames oldest first.
pub fn observed_field(radar: &RadarGrid, frames: &[Vec<f32>], step_s: f64, target: &TargetGrid, min_coverage: f64) -> Result<RainField, String> {
    if target.w == 0 || target.h == 0 || !(target.cell.is_finite() && target.cell > 0.0 && target.x0.is_finite() && target.y0.is_finite()) {
        return Err("target grid needs cells and a positive cell size".into());
    }
    observed_field_at(radar, frames, step_s, &target.points(), target.w, target.h, min_coverage)
}

/// [`observed_field`] for cells at arbitrary points: `points` holds the `w` x `h` cell centres row by row
/// (used to fill an uncovered edge from its neighbours).
pub fn observed_field_at(radar: &RadarGrid, frames: &[Vec<f32>], step_s: f64, points: &[(f64, f64)], w: usize, h: usize, min_coverage: f64) -> Result<RainField, String> {
    if frames.is_empty() { return Err("no radar frames".into()); }
    if !(min_coverage > 0.0 && min_coverage <= 1.0) { return Err("minimum coverage must be above 0 and at most 1".into()); }
    if points.len() != w * h { return Err("points do not match the grid".into()); }
    let mut out = Vec::with_capacity(frames.len());
    for (k, f) in frames.iter().enumerate() {
        let (mut rates, coverage) = resample_points(radar, f, points)?;
        if coverage < min_coverage {
            return Err(format!("radar frame {k} covers only {:.0}% of the area (needs {:.0}%)", coverage * 100.0, min_coverage * 100.0));
        }
        if rates.iter().any(|v| v.is_nan()) {
            // partly covered but above the minimum: the uncovered edge cells take the nearest frame value, never a silent zero
            fill_from_neighbours(&mut rates, w, h);
        }
        for v in rates.iter_mut() { *v = v.clamp(0.0, MAX_RATE as f32); }
        out.push(rates);
    }
    let field = RainField { step_s, frames: out };
    field.validate(w * h)?;
    Ok(field)
}

/// Replace NaN cells by the nearest finite cell's value (breadth-first from the finite cells). Every
/// cell ends finite if any was.
fn fill_from_neighbours(v: &mut [f32], w: usize, h: usize) {
    let mut queue: std::collections::VecDeque<usize> = (0..w * h).filter(|&i| v[i].is_finite()).collect();
    while let Some(i) = queue.pop_front() {
        let (x, y) = (i % w, i / w);
        for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
            if nx < w && ny < h && v[ny * w + nx].is_nan() { v[ny * w + nx] = v[i]; queue.push_back(ny * w + nx); }
        }
    }
}

/// One step of an image legend: pixels this close to `rgb` (nearest wins) mean `mm_h`.
#[derive(Clone, Copy, Debug)]
pub struct LegendEntry { pub rgb: [u8; 3], pub mm_h: f32 }

/// Decode an RGBA image (row-major, 4 bytes a pixel) of a radar legend to rain rates. Fully
/// transparent pixels (alpha 0) are no echo, so 0 mm/h; any other pixel takes the rate of the nearest
/// legend colour (squared RGB distance), and a pixel further than `max_distance` from every entry is
/// an error rather than a guess. The legend must come from the image source's own documentation.
pub fn decode_legend(rgba: &[u8], legend: &[LegendEntry], max_distance: f64) -> Result<Vec<f32>, String> {
    if legend.is_empty() { return Err("legend is empty".into()); }
    if !rgba.len().is_multiple_of(4) { return Err("image is not whole RGBA pixels".into()); }
    let limit = max_distance * max_distance;
    let mut out = Vec::with_capacity(rgba.len() / 4);
    #[allow(clippy::chunks_exact_to_as_chunks)]
    for p in rgba.chunks_exact(4) {
        if p[3] == 0 { out.push(0.0); continue; }
        let d = |e: &LegendEntry| (0..3).map(|c| (p[c] as f64 - e.rgb[c] as f64).powi(2)).sum::<f64>();
        let best = legend.iter().map(|e| (d(e), e.mm_h)).min_by(|a, b| a.0.total_cmp(&b.0)).unwrap();
        if best.0 > limit { return Err(format!("pixel ({}, {}, {}) is not in the legend", p[0], p[1], p[2])); }
        out.push(best.1);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // a 1 km radar over a 10 x 10 km area with the origin at (0, 0), and a 100 m solver grid inside it
    const RADAR: RadarGrid = RadarGrid { w: 10, h: 10, x0: 0.0, y0: 0.0, dx: 1000.0, dy: 1000.0 };
    fn target(w: usize, h: usize, x0: f64, y0: f64) -> TargetGrid { TargetGrid { w, h, x0, y0, cell: 100.0 } }

    #[test]
    fn a_constant_frame_stays_constant_and_a_linear_one_is_reproduced() {
        let t = target(40, 30, 3000.0, 3000.0);
        let (flat, cov) = resample(&RADAR, &vec![12.5; 100], &t).unwrap();
        assert_eq!(cov, 1.0);
        assert!(flat.iter().all(|v| (*v - 12.5).abs() < 1e-5));
        // rate = x in km (cell centres at 0.5, 1.5, ...): bilinear reproduces a linear field exactly
        let ramp: Vec<f32> = (0..100).map(|k| (k % 10) as f32 + 0.5).collect();
        let (r, _) = resample(&RADAR, &ramp, &t).unwrap();
        for (i, v) in r.iter().take(40).enumerate() { let x_km = (3000.0 + (i as f64 + 0.5) * 100.0) / 1000.0; assert!((*v as f64 - x_km).abs() < 1e-4, "{i}: {v} vs {x_km}"); }
    }

    #[test]
    fn cells_outside_the_radar_are_not_zero_and_coverage_says_so() {
        // half the target lies east of the radar's 10 km
        let t = target(40, 10, 8000.0, 2000.0);
        let (r, cov) = resample(&RADAR, &vec![5.0; 100], &t).unwrap();
        assert!(cov < 0.6 && cov > 0.3, "{cov}");
        assert!(r.iter().filter(|v| v.is_nan()).count() > 0);
        // a frame that does not cover enough is refused rather than padded with dry cells
        let err = observed_field(&RADAR, &[vec![5.0; 100]], 600.0, &t, 0.95).unwrap_err();
        assert!(err.contains("covers only"), "{err}");
        // partial cover above the minimum fills the edge from the nearest value, not zero
        let f = observed_field(&RADAR, &[vec![5.0; 100]], 600.0, &t, 0.3).unwrap();
        assert!(f.frames[0].iter().all(|v| (*v - 5.0).abs() < 1e-5), "edge cells take the nearest rain, not 0: {:?}", &f.frames[0][..5]);
    }

    #[test]
    fn observed_frames_become_a_rain_field_in_order() {
        let t = target(20, 20, 4000.0, 4000.0);
        let frames: Vec<Vec<f32>> = [0.0, 10.0, 40.0, 5000.0].iter().map(|r| vec![*r as f32; 100]).collect();
        let f = observed_field(&RADAR, &frames, 600.0, &t, 0.99).unwrap();
        assert_eq!(f.frames.len(), 4); assert_eq!(f.step_s, 600.0);
        assert_eq!(f.frames[0][0], 0.0); assert!((f.frames[2][399] - 40.0).abs() < 1e-5);
        assert_eq!(f.frames[3][0], 1000.0, "rates are capped at the solver's limit");
        assert!(observed_field(&RADAR, &[], 600.0, &t, 0.9).is_err());
        assert!(observed_field(&RADAR, &frames, 600.0, &t, 0.0).is_err());
        assert!(observed_field(&RADAR, &[vec![1.0; 99]], 600.0, &t, 0.9).is_err(), "wrong frame size");
        // a negative interpolation overshoot counts as dry
        let mut neg = vec![0.0_f32; 100]; neg[44] = -0.3;
        let f = observed_field(&RADAR, &[neg], 600.0, &t, 0.9).unwrap();
        assert!(f.frames[0].iter().all(|v| *v >= 0.0));
    }

    #[test]
    fn a_smooth_storm_keeps_its_volume_through_resampling() {
        // a storm peak in the middle of the radar; the 100 m grid should hold about the same mean rain as the 1 km data
        let frame: Vec<f32> = (0..100).map(|k| { let (x, y) = ((k % 10) as f32 - 4.5, (k / 10) as f32 - 4.5); 50.0 * (-(x * x + y * y) / 8.0).exp() }).collect();
        let t = target(60, 60, 2000.0, 2000.0);   // the 6 x 6 km centre of the radar
        let (r, _) = resample(&RADAR, &frame, &t).unwrap();
        let fine = r.iter().map(|v| *v as f64).sum::<f64>() / r.len() as f64;
        // the same 6 km square from the radar's own cells
        let coarse = (2..8).flat_map(|y| (2..8).map(move |x| (x, y))).map(|(x, y)| frame[y * 10 + x] as f64).sum::<f64>() / 36.0;
        assert!((fine - coarse).abs() / coarse < 0.05, "{fine} vs {coarse}");
    }

    #[test]
    fn a_legend_decodes_colours_to_rates_and_refuses_unknown_ones() {
        let legend = [LegendEntry { rgb: [0, 0, 255], mm_h: 1.0 }, LegendEntry { rgb: [0, 255, 0], mm_h: 10.0 }, LegendEntry { rgb: [255, 0, 0], mm_h: 50.0 }];
        let img = [0, 0, 250, 255, 5, 250, 5, 255, 250, 3, 0, 255, 99, 99, 99, 0];
        assert_eq!(decode_legend(&img, &legend, 30.0).unwrap(), vec![1.0, 10.0, 50.0, 0.0]);
        assert!(decode_legend(&[128, 128, 128, 255], &legend, 30.0).unwrap_err().contains("not in the legend"));
        assert!(decode_legend(&[1, 2, 3], &legend, 30.0).is_err());
        assert!(decode_legend(&img, &[], 30.0).is_err());
    }
}
