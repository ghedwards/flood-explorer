//! Grid adaptation for the local-inertial 2D solver: the area model's terrain averaged into blocks small enough for the solver (`prepare`), which area cell falls in which
//! block (`cell_of`), and the solver's answer spread back over the area model's cells in the shape the map and the impact tools take (`expand`). The hydraulics are in
//! `inertial`; this only moves terrain and results between the two grids.

use crate::dam::Area;

/// The area model's terrain averaged into blocks of `factor` by `factor` cells. A block with any missing ground is a wall (never a new flow shortcut), and a block counts as sea
/// only if every cell in it is.
pub struct Prepared { pub w: usize, pub h: usize, pub cell: f64, pub dem: Vec<f64>, pub valid: Vec<u8>, pub ocean: Vec<u8>, pub factor: usize }

pub fn prepare(a: &Area, max_side: usize) -> Result<Prepared, String> {
    let factor = ((a.w.max(a.h) as f64 / max_side.max(1) as f64).ceil() as usize).max(1);
    let (w, h) = (a.w / factor, a.h / factor);
    if w == 0 || h == 0 { return Err("Terrain is too narrow for this resolution.".into()); }
    let (mut dem, mut valid, mut ocean) = (vec![0.0; w * h], vec![0u8; w * h], vec![0u8; w * h]);
    for y in 0..h { for x in 0..w {
        let (mut z, mut count, mut sea) = (0.0, 0usize, 0usize);
        for yy in 0..factor { for xx in 0..factor {
            let i = (y * factor + yy) * a.w + x * factor + xx;
            if (a.valid.is_empty() || a.valid[i] != 0) && a.dem[i].is_finite() { z += a.dem[i]; count += 1; }
            if !a.ocean.is_empty() && a.ocean[i] != 0 { sea += 1; }
        } }
        let j = y * w + x;
        valid[j] = u8::from(count == factor * factor);
        dem[j] = if count > 0 { z / count as f64 } else { 0.0 };
        ocean[j] = u8::from(valid[j] != 0 && sea == factor * factor);
    } }
    Ok(Prepared { w, h, cell: a.cell * factor as f64, dem, valid, ocean, factor })
}

/// The block of the prepared grid that area cell `i` falls in, or None (outside the area, or in the partial edge blocks that are left out).
pub fn cell_of(g: &Prepared, a: &Area, i: i64) -> Option<usize> {
    if i < 0 || i as usize >= a.w * a.h { return None; }
    let i = i as usize;
    let (x, y) = ((i % a.w) / g.factor, (i / a.w) / g.factor);
    (x < g.w && y < g.h).then(|| y * g.w + x)
}

/// What the solver ended with, per block. `depth` is the final water depth; the rest are there for a storm run, which keeps the deepest water (`peak`), the worst hazard class,
/// the fastest speed and the seconds until water first stood 10 cm up (negative where it did not).
pub struct SolverResult<'a> { pub depth: &'a [f64], pub peak: Option<&'a [f64]>, pub vx: Option<&'a [f64]>, pub vy: Option<&'a [f64]>, pub peak_class: Option<&'a [f64]>, pub peak_speed: Option<&'a [f64]>, pub arrival: Option<&'a [f64]> }

pub struct Hazard { pub class: Vec<u8>, pub speed: Vec<f32>, pub km2: [f64; 6] }

pub struct Expanded {
    pub depth: Vec<f32>,
    pub wet: Vec<u8>,
    pub level: Vec<f32>,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    /// Seconds until 10 cm (NaN where it never came): only for a storm run.
    pub arrival: Option<Vec<f32>>,
    pub hazard: Option<Hazard>,
}

/// Spread the solver's blocks over the area model's cells. With `peak` the map shows the deepest water each cell held instead of the final depth; a storm run (peak, with its class
/// and arrival) also gives the worst hazard class, the speed and the arrival time, and the area in each class (land cells only).
pub fn expand(a: &Area, g: &Prepared, r: &SolverResult, peak: bool) -> Expanded {
    let n = a.w * a.h;
    let depths = match (peak, r.peak) { (true, Some(p)) => p, _ => r.depth };
    let track = peak && r.peak.is_some() && r.peak_class.is_some() && r.arrival.is_some();
    let mut out = Expanded { depth: vec![0.0; n], wet: vec![0; n], level: vec![f32::NAN; n], vx: vec![0.0; n], vy: vec![0.0; n], arrival: track.then(|| vec![f32::NAN; n]), hazard: track.then(|| Hazard { class: vec![0; n], speed: vec![0.0; n], km2: [0.0; 6] }) };
    for i in 0..n {
        let Some(j) = cell_of(g, a, i as i64) else { continue };
        if g.valid[j] == 0 || (!a.valid.is_empty() && a.valid[i] == 0) { continue; }
        out.depth[i] = depths[j] as f32;
        out.wet[i] = u8::from(out.depth[i] >= 0.01);
        out.level[i] = (g.dem[j] + depths[j]) as f32;
        if let Some(vx) = r.vx { out.vx[i] = vx[j]; }
        if let Some(vy) = r.vy { out.vy[i] = vy[j]; }
        if let (Some(hz), Some(arrival), Some(class), Some(speed)) = (out.hazard.as_mut(), out.arrival.as_mut(), r.peak_class, r.peak_speed) {
            hz.class[i] = class[j] as u8;
            hz.speed[i] = speed[j] as f32;
            if r.arrival.is_some_and(|t| t[j] >= 0.0) { arrival[i] = r.arrival.unwrap()[j] as f32; }
        }
    }
    if let Some(hz) = out.hazard.as_mut() {
        let cell_km2 = a.cell * a.cell / 1e6;
        for i in 0..n { if hz.class[i] > 0 && !(!a.ocean.is_empty() && a.ocean[i] != 0) { hz.km2[hz.class[i] as usize - 1] += cell_km2; } }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(w: usize, h: usize, cell: f64) -> Area { Area { w, h, cell, dem: vec![2.0; w * h], valid: vec![1; w * h], ocean: vec![0; w * h] } }

    #[test]
    fn coarsening_preserves_walls_and_bounds_and_reports_the_actual_resolution() {
        let mut a = area(7, 6, 10.0);
        a.valid[0] = 0;
        let g = prepare(&a, 4).unwrap();
        assert_eq!((g.factor, g.cell, g.w, g.h), (2, 20.0, 3, 3));
        assert_eq!((g.valid[0], g.valid[1]), (0, 1));
        assert_eq!(cell_of(&g, &a, 6), None);
        assert_eq!(cell_of(&g, &a, -1), None);
        assert_eq!(cell_of(&g, &a, 2), Some(1));
        let r = expand(&a, &g, &SolverResult { depth: &[0.2; 9], peak: None, vx: None, vy: None, peak_class: None, peak_speed: None, arrival: None }, false);
        assert_eq!((r.wet[0], r.wet[1], r.wet[6]), (0, 0, 0));
        assert_eq!(r.wet[2], 1);
        assert!((r.depth[2] - 0.2).abs() < 1e-7);
        assert!(prepare(&area(3, 3, 10.0), 100).is_ok());
        assert!(prepare(&Area { w: 1, h: 9, ..area(1, 9, 10.0) }, 1).is_err(), "a strip narrower than a block has no blocks");
    }

    #[test]
    fn a_storm_run_expands_its_peak_depth_hazard_classes_and_arrival_onto_the_fine_grid() {
        let mut a = area(4, 2, 30.0);
        a.ocean[7] = 1;
        let g = prepare(&a, 2).unwrap();   // 2 x 1 coarse cells of 60 m
        assert_eq!((g.w, g.h), (2, 1));
        let result = SolverResult { depth: &[0.0, 0.0], peak: Some(&[0.8, 0.05]), vx: None, vy: None, peak_class: Some(&[4.0, 1.0]), peak_speed: Some(&[1.5, 0.1]), arrival: Some(&[300.0, -1.0]) };
        let run = expand(&a, &g, &result, true);
        assert!((run.depth[0] - 0.8).abs() < 1e-7, "the map shows the peak, not the final depth");
        assert_eq!((run.wet[0], run.wet[3]), (1, 1));
        let hz = run.hazard.as_ref().unwrap();
        assert_eq!((hz.class[0], hz.class[3]), (4, 1));
        assert!((hz.speed[0] - 1.5).abs() < 1e-6);
        let arrival = run.arrival.as_ref().unwrap();
        assert!(arrival[3].is_nan() && (arrival[0] - 300.0).abs() < 1e-6, "a cell never flooded has no arrival time");
        // km2 per class counts land cells only (the 30 m ocean cell is left out): 4 fine cells at 0.0009 km2 under the first coarse cell
        assert!((hz.km2[3] - 4.0 * 0.0009).abs() < 1e-12 && (hz.km2[0] - 3.0 * 0.0009).abs() < 1e-12, "{:?}", hz.km2);
        let plain = expand(&a, &g, &SolverResult { depth: &[0.1, 0.1], peak: Some(&[0.8, 0.05]), vx: None, vy: None, peak_class: None, peak_speed: None, arrival: None }, false);
        assert!(plain.hazard.is_none() && plain.arrival.is_none());
        assert!((plain.depth[0] - 0.1).abs() < 1e-7, "without the peak option the final depth is shown");
    }
}
