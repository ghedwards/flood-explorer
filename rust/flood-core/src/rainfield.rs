//! Rain that varies across the map, for the 2D solver.
//!
//! The solver's `rain_series` puts the same rate on every cell. A [`RainField`] gives each cell its
//! own rate in every step, so a storm can have a core and edges and move across the area. Frames
//! hold for their whole step (no interpolation in time), like the series entries do.
//!
//! [`apply_losses`] takes a raw rain field to the rain that does not soak in, cell by cell, with the
//! same two losses (initial and continuing) that `flash::effective_rain_series` applies to a whole
//! catchment. [`moving_storm`] makes a synthetic drifting storm for tests and what-if runs.
use crate::flash::MAX_RATE;

/// The most rate values (frames x cells) a field may hold: 16 million, 64 MB as `f32`.
pub const MAX_VALUES: usize = 16_000_000;

/// Rain rates (mm/h) for every cell of the solver grid at every step.
#[derive(Clone, Debug, PartialEq)]
pub struct RainField {
    /// Seconds each frame lasts (1 s to 24 h).
    pub step_s: f64,
    /// One frame per step, each holding one rate per grid cell in row-major order.
    pub frames: Vec<Vec<f32>>,
}

impl RainField {
    /// Check the field against a grid of `cells` cells: a step of 1 s to 24 h, at least one frame,
    /// every frame the size of the grid, every rate finite and from 0 to 1000 mm/h, and no more
    /// than [`MAX_VALUES`] values in all.
    pub fn validate(&self, cells: usize) -> Result<(), String> {
        if !(self.step_s.is_finite() && (1.0..=86400.0).contains(&self.step_s)) {
            return Err("rain field step must be 1 second to 24 hours".into());
        }
        if self.frames.is_empty() { return Err("rain field needs at least one frame".into()); }
        if self.frames.len().checked_mul(cells).is_none_or(|v| v > MAX_VALUES) {
            return Err("rain field is too large; use fewer frames or a coarser grid".into());
        }
        for (k, f) in self.frames.iter().enumerate() {
            if f.len() != cells { return Err(format!("rain field frame {k} has {} values for {cells} cells", f.len())); }
            if f.iter().any(|v| !(v.is_finite() && (0.0..=MAX_RATE as f32).contains(v))) {
                return Err(format!("rain field frame {k} has a rate outside 0 to {MAX_RATE} mm/h"));
            }
        }
        Ok(())
    }
    /// The seconds the whole field covers.
    pub fn seconds(&self) -> f64 { self.step_s * self.frames.len() as f64 }
    /// The frame in force at `time` seconds from the start. After the last frame the last one
    /// stays in force, as with a series; end a storm with zero frames so the water can drain.
    pub fn frame_at(&self, time: f64) -> &[f32] {
        let k = if time > 0.0 { (time / self.step_s) as usize } else { 0 };
        &self.frames[k.min(self.frames.len() - 1)]
    }
    /// Millimetres of rain that fall on a cell over the whole field.
    pub fn total_mm(&self, cell: usize) -> f64 {
        self.frames.iter().map(|f| f[cell] as f64).sum::<f64>() * self.step_s / 3600.0
    }
}

/// Take the rain a field puts down to the rain that does not soak in, cell by cell.
///
/// Each cell has its own initial loss (mm, soaked up first) and continuing loss (mm/h). As in
/// `flash::effective_rain_series`, continuing-loss capacity builds up from the start whether or not
/// it is raining and is banked, so a cell's total loss is at most its initial loss plus its
/// continuing loss times the elapsed hours. A NaN or negative loss counts as 0. The result has the
/// same step and size and its rates are capped at the solver's 1000 mm/h.
pub fn apply_losses(field: &RainField, initial_loss_mm: f64, continuing_mm_h: f64) -> Result<RainField, String> {
    let cells = field.frames.first().map_or(0, Vec::len);
    field.validate(cells)?;
    let clean = |v: f64| if v.is_nan() { 0.0 } else { v.max(0.0) };
    let (initial0, cont) = (clean(initial_loss_mm), clean(continuing_mm_h));
    if !initial0.is_finite() || !cont.is_finite() { return Err("losses must be finite".into()); }
    let step_h = field.step_s / 3600.0;
    let mut initial = vec![initial0; cells];
    let mut bank = vec![0.0_f64; cells];
    let mut frames = Vec::with_capacity(field.frames.len());
    for frame in &field.frames {
        let mut out = vec![0.0_f32; cells];
        for i in 0..cells {
            let rain = frame[i] as f64 * step_h;
            let absorbed = rain.min(initial[i]);
            initial[i] -= absorbed;
            bank[i] += cont * step_h;
            let soaked = (rain - absorbed).min(bank[i]);
            bank[i] -= soaked;
            out[i] = (((rain - absorbed - soaked) / step_h).min(MAX_RATE)) as f32;
        }
        frames.push(out);
    }
    Ok(RainField { step_s: field.step_s, frames })
}

/// A storm that drifts across a grid: a Gaussian rain cell on top of a steady background.
pub struct MovingStorm {
    pub w: usize,
    pub h: usize,
    /// Cell size (m).
    pub cell: f64,
    pub step_s: f64,
    pub steps: usize,
    /// Rate at the storm's centre, on top of the background (mm/h).
    pub peak_mm_h: f64,
    /// Distance from the centre at which the rate has fallen to e^-0.5 of the peak (m).
    pub sigma_m: f64,
    /// Where the centre is at time 0, in metres from the grid's top-left corner (x east, y south).
    pub start_m: (f64, f64),
    /// How fast the centre moves (m/s, x east, y south).
    pub velocity_m_s: (f64, f64),
    /// Rain everywhere, all the time (mm/h).
    pub background_mm_h: f64,
}

/// Build the field for a [`MovingStorm`]. Each frame is evaluated at the middle of its step, with
/// the centre of the cell as the cell's position, and rates are capped at 1000 mm/h.
pub fn moving_storm(s: &MovingStorm) -> Result<RainField, String> {
    if s.w == 0 || s.h == 0 || s.steps == 0 { return Err("storm needs a grid and at least one step".into()); }
    if !(s.cell.is_finite() && s.cell > 0.0 && s.sigma_m.is_finite() && s.sigma_m > 0.0) { return Err("storm needs a positive cell size and spread".into()); }
    if ![s.peak_mm_h, s.background_mm_h].iter().all(|v| v.is_finite() && *v >= 0.0)
        || ![s.start_m.0, s.start_m.1, s.velocity_m_s.0, s.velocity_m_s.1].iter().all(|v| v.is_finite()) {
        return Err("storm rates must be finite and not negative".into());
    }
    let mut frames = Vec::with_capacity(s.steps);
    for k in 0..s.steps {
        let t = (k as f64 + 0.5) * s.step_s;
        let (cx, cy) = (s.start_m.0 + s.velocity_m_s.0 * t, s.start_m.1 + s.velocity_m_s.1 * t);
        let mut frame = Vec::with_capacity(s.w * s.h);
        for j in 0..s.h {
            for i in 0..s.w {
                let (dx, dy) = ((i as f64 + 0.5) * s.cell - cx, (j as f64 + 0.5) * s.cell - cy);
                let g = (-(dx * dx + dy * dy) / (2.0 * s.sigma_m * s.sigma_m)).exp();
                frame.push((s.background_mm_h + s.peak_mm_h * g).min(MAX_RATE) as f32);
            }
        }
        frames.push(frame);
    }
    let field = RainField { step_s: s.step_s, frames };
    field.validate(s.w * s.h)?;
    Ok(field)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flash::effective_rain_series;

    fn uniform(cells: usize, rates: &[f64], step_s: f64) -> RainField {
        RainField { step_s, frames: rates.iter().map(|r| vec![*r as f32; cells]).collect() }
    }

    #[test]
    fn validation_catches_a_bad_step_size_rate_and_shape() {
        let ok = uniform(6, &[10.0, 0.0], 600.0);
        assert!(ok.validate(6).is_ok());
        assert!(ok.validate(5).is_err(), "frames must match the grid");
        for bad in [0.0, 0.5, -1.0, f64::NAN, f64::INFINITY, 1e6] {
            let mut f = ok.clone(); f.step_s = bad; assert!(f.validate(6).is_err(), "{bad}");
        }
        for bad in [-0.1_f32, 1000.5, f32::NAN, f32::INFINITY] {
            let mut f = ok.clone(); f.frames[1][3] = bad; assert!(f.validate(6).is_err(), "{bad}");
        }
        assert!(RainField { step_s: 600.0, frames: vec![] }.validate(6).is_err());
        let huge = RainField { step_s: 600.0, frames: vec![vec![0.0; 1]; 1] };
        assert!(huge.validate(MAX_VALUES + 1).is_err(), "too many values");
    }

    #[test]
    fn a_frame_holds_for_its_step_and_the_last_one_stays_in_force() {
        let f = uniform(1, &[1.0, 2.0, 3.0], 600.0);
        assert_eq!(f.frame_at(0.0)[0], 1.0);
        assert_eq!(f.frame_at(599.9)[0], 1.0);
        assert_eq!(f.frame_at(600.0)[0], 2.0);
        assert_eq!(f.frame_at(1799.0)[0], 3.0);
        assert_eq!(f.frame_at(1e6)[0], 3.0);
        assert_eq!(f.frame_at(-5.0)[0], 1.0);
        assert!((f.seconds() - 1800.0).abs() < 1e-12);
    }

    #[test]
    fn losses_on_a_uniform_field_match_the_catchment_wide_series() {
        // 60 mm over 1 h in 10-minute steps, 15 mm initial loss, 2.5 mm/h continuing, 2 h to drain
        let r = effective_rain_series(60.0, 1.0, 15.0, 2.5, 2.0, 600.0).unwrap();
        let steps = r.series.len();
        let raw: Vec<f64> = (0..steps).map(|k| if k < 6 { 60.0 } else { 0.0 }).collect();
        let out = apply_losses(&uniform(4, &raw, 600.0), 15.0, 2.5).unwrap();
        for (k, expected) in r.series.iter().enumerate() {
            for c in 0..4 { assert!((out.frames[k][c] as f64 - expected).abs() < 1e-4, "step {k}: {} vs {expected}", out.frames[k][c]); }
        }
    }

    #[test]
    fn losses_work_cell_by_cell() {
        // one cell gets a downpour, one a drizzle that the ground takes entirely
        let f = RainField { step_s: 600.0, frames: vec![vec![80.0, 4.0]; 6] };
        let out = apply_losses(&f, 10.0, 2.0).unwrap();
        let runoff = |c: usize| out.frames.iter().map(|fr| fr[c] as f64).sum::<f64>() * 600.0 / 3600.0;
        // downpour: 80 mm in the hour, less 10 mm initial and 2 mm continuing
        assert!((runoff(0) - 68.0).abs() < 1e-3, "{}", runoff(0));
        assert_eq!(runoff(1), 0.0, "4 mm in an hour is all soaked up");
        // losses never make rain
        assert!(out.frames.iter().all(|fr| fr.iter().all(|v| *v >= 0.0)));
        // NaN and negative losses count as none
        let none = apply_losses(&f, f64::NAN, -3.0).unwrap();
        assert_eq!(none, f);
    }

    #[test]
    fn a_moving_storm_moves_and_peaks_at_its_centre() {
        let s = MovingStorm { w: 41, h: 11, cell: 10.0, step_s: 100.0, steps: 5, peak_mm_h: 100.0, sigma_m: 30.0,
            start_m: (50.0, 55.0), velocity_m_s: (0.5, 0.0), background_mm_h: 5.0 };
        let f = moving_storm(&s).unwrap();
        let peak_col = |k: usize| { let fr = &f.frames[k]; let m = fr.iter().copied().fold(0.0, f32::max);
            fr.iter().position(|v| *v == m).unwrap() % 41 };
        let cols: Vec<usize> = (0..5).map(peak_col).collect();
        assert!(cols.windows(2).all(|p| p[0] < p[1]), "the storm drifts east: {cols:?}");
        // centre of frame 0 is at x = 50 + 0.5 * 50 = 75 m, so column 7 (cell centre 75 m)
        assert_eq!(cols[0], 7);
        // far from the core only the background falls
        assert!((f.frames[0][41 * 5 + 40] - 5.0).abs() < 0.5);
        assert!(f.frames[0].iter().all(|v| *v >= 5.0 && *v <= 105.0));
        let mut bad = s; bad.sigma_m = 0.0; assert!(moving_storm(&bad).is_err());
    }
}
