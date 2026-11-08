//! A short rain forecast by extrapolation: find how the rain is moving in the latest radar frames and
//! carry the latest frame forward along that motion.
//!
//! This is the simplest honest nowcast. It cannot make rain appear, grow or fade (apart from an
//! optional exponential decay you choose), and rain upwind of the radar's edge is unknown, so those
//! cells come back as NaN rather than as dry. Skill falls away within an hour or so, faster for small
//! showers. It has been tested here only on synthetic storms; see docs/radar-nowcast-design.md.
//!
//! Frames are instantaneous snapshots at equal spacing `step_s`, oldest first, the last one being
//! "now". Forecast frame k covers `[now + k*step_s, now + (k+1)*step_s)` and is the latest frame
//! carried to the middle of that interval, so it can be handed straight to the solver as a
//! [`RainField`](crate::rainfield::RainField) through [`crate::radar::observed_field`].
use crate::radar::RadarGrid;

/// One motion vector for the whole frame, in m/s, x east and y south (the radar grid's axes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub u_m_s: f64,
    pub v_m_s: f64,
    /// The best normalised cross-correlation found between consecutive frames (0 to 1), averaged over the
    /// pairs used. Low means the rain did not keep its shape and the vector should not be trusted.
    pub correlation: f64,
    /// False when there was too little rain, or too poor a match, to find a motion; the vector is then 0.
    pub reliable: bool,
}

/// A forecast: one frame per step, with the share of cells whose value is known in each (the rest are NaN).
#[derive(Clone, Debug)]
pub struct Nowcast {
    pub frames: Vec<Vec<f32>>,
    pub known_share: Vec<f64>,
    pub motion: Motion,
}

/// Rain at least this heavy (mm/h) counts as rain when deciding whether a frame can be matched.
const RAIN_MM_H: f32 = 0.2;
/// The least a frame pair's best correlation may be for its motion to be used.
const MIN_CORRELATION: f64 = 0.5;
/// The fewest rainy cells a frame needs for its motion to be estimated.
const MIN_RAINY_CELLS: usize = 4;

fn check(frames: &[Vec<f32>], grid: &RadarGrid, step_s: f64) -> Result<(), String> {
    if !(step_s.is_finite() && step_s > 0.0) { return Err("frame spacing must be positive".into()); }
    if frames.is_empty() { return Err("no radar frames".into()); }
    for (k, f) in frames.iter().enumerate() {
        if f.len() != grid.w * grid.h { return Err(format!("radar frame {k} has {} values for {} cells", f.len(), grid.w * grid.h)); }
        if f.iter().any(|v| !v.is_finite() || *v < 0.0) { return Err(format!("radar frame {k} has a missing or negative rate; fill gaps before forecasting")); }
    }
    Ok(())
}

/// Normalised cross-correlation of `a` shifted by (sx, sy) cells onto `b`, over the cells where both
/// exist. None if the overlap is under half the frame or either side has no rain in it.
fn correlation(a: &[f32], b: &[f32], w: usize, h: usize, sx: isize, sy: isize) -> Option<f64> {
    let (x0, x1) = (sx.max(0) as usize, (w as isize + sx.min(0)) as usize);
    let (y0, y1) = (sy.max(0) as usize, (h as isize + sy.min(0)) as usize);
    if x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) * 2 < w * h { return None; }
    let (mut ab, mut aa, mut bb) = (0.0f64, 0.0f64, 0.0f64);
    for y in y0..y1 {
        for x in x0..x1 {
            let av = a[(y as isize - sy) as usize * w + (x as isize - sx) as usize] as f64;
            let bv = b[y * w + x] as f64;
            ab += av * bv; aa += av * av; bb += bv * bv;
        }
    }
    if aa <= 0.0 || bb <= 0.0 { None } else { Some(ab / (aa * bb).sqrt()) }
}

/// How far rain moved from `a` to `b`, in cells (x east, y south), by exhaustive search over whole-cell
/// shifts up to `max_cells` then a parabola through the best score and its neighbours on each axis.
fn shift_between(a: &[f32], b: &[f32], w: usize, h: usize, max_cells: isize) -> Option<(f64, f64, f64)> {
    let mut best: Option<(isize, isize, f64)> = None;
    for sy in -max_cells..=max_cells {
        for sx in -max_cells..=max_cells {
            if let Some(c) = correlation(a, b, w, h, sx, sy) {
                // ties go to the smaller shift, so still rain reads as still
                let better = best.is_none_or(|(bx, by, bc)| c > bc + 1e-12 || ((c - bc).abs() <= 1e-12 && sx.abs() + sy.abs() < bx.abs() + by.abs()));
                if better { best = Some((sx, sy, c)); }
            }
        }
    }
    let (bx, by, c) = best?;
    let parabola = |lo: Option<f64>, hi: Option<f64>| -> f64 {
        match (lo, hi) {
            (Some(l), Some(r)) => { let d = l - 2.0 * c + r; if d < -1e-12 { (0.5 * (l - r) / d).clamp(-0.5, 0.5) } else { 0.0 } }
            _ => 0.0,
        }
    };
    let fx = parabola(correlation(a, b, w, h, bx - 1, by), correlation(a, b, w, h, bx + 1, by));
    let fy = parabola(correlation(a, b, w, h, bx, by - 1), correlation(a, b, w, h, bx, by + 1));
    Some((bx as f64 + fx, by as f64 + fy, c))
}

/// Estimate how the rain is moving from consecutive frames (oldest first; at least two). Each
/// consecutive pair with enough rain and a good enough match votes, weighted by its correlation, and
/// speeds above `max_speed_m_s` are not searched. Returns an unreliable zero motion when no pair is usable.
pub fn estimate_motion(frames: &[Vec<f32>], grid: &RadarGrid, step_s: f64, max_speed_m_s: f64) -> Result<Motion, String> {
    check(frames, grid, step_s)?;
    if frames.len() < 2 { return Err("estimating motion needs at least two frames".into()); }
    if !(max_speed_m_s.is_finite() && max_speed_m_s > 0.0) { return Err("maximum speed must be positive".into()); }
    let max_cells = ((max_speed_m_s * step_s / grid.dx.min(grid.dy)).ceil() as isize).clamp(1, 40);
    let (mut sum_x, mut sum_y, mut sum_c, mut sum_w) = (0.0, 0.0, 0.0, 0.0);
    for pair in frames.windows(2) {
        let rainy = |f: &Vec<f32>| f.iter().filter(|v| **v >= RAIN_MM_H).count();
        if rainy(&pair[0]) < MIN_RAINY_CELLS || rainy(&pair[1]) < MIN_RAINY_CELLS { continue; }
        if let Some((sx, sy, c)) = shift_between(&pair[0], &pair[1], grid.w, grid.h, max_cells) {
            if c >= MIN_CORRELATION { sum_x += sx * c; sum_y += sy * c; sum_c += c; sum_w += 1.0; }
        }
    }
    if sum_c <= 0.0 { return Ok(Motion { u_m_s: 0.0, v_m_s: 0.0, correlation: 0.0, reliable: false }); }
    Ok(Motion { u_m_s: sum_x / sum_c * grid.dx / step_s, v_m_s: sum_y / sum_c * grid.dy / step_s, correlation: sum_c / sum_w, reliable: true })
}

/// Carry a frame forward `lead_s` seconds along `motion`: each cell takes the value found upwind at
/// the place the rain came from, bilinear. Cells whose upwind place is outside the radar are NaN.
pub fn advect(frame: &[f32], grid: &RadarGrid, motion: &Motion, lead_s: f64) -> Result<Vec<f32>, String> {
    if frame.len() != grid.w * grid.h { return Err("frame does not match the radar grid".into()); }
    if !lead_s.is_finite() { return Err("lead time must be finite".into()); }
    let (ox, oy) = (motion.u_m_s * lead_s, motion.v_m_s * lead_s);
    let mut out = Vec::with_capacity(frame.len());
    for j in 0..grid.h {
        for i in 0..grid.w {
            let (x, y) = (grid.x0 + (i as f64 + 0.5) * grid.dx, grid.y0 + (j as f64 + 0.5) * grid.dy);
            out.push(grid.sample(frame, x - ox, y - oy));
        }
    }
    Ok(out)
}

/// Forecast `horizon_s` ahead in steps of `step_s`: the motion from all the frames, the latest frame
/// carried to the middle of each step, optionally fading as `exp(-lead / decay_tau_s)` (pass
/// `f64::INFINITY` for no decay; the decay is a modelling choice, not something fitted). Rain that
/// would have come from outside the radar is NaN and counted out of `known_share`.
pub fn nowcast(frames: &[Vec<f32>], grid: &RadarGrid, step_s: f64, horizon_s: f64, decay_tau_s: f64, max_speed_m_s: f64) -> Result<Nowcast, String> {
    if !(horizon_s.is_finite() && horizon_s > 0.0 && horizon_s <= 6.0 * 3600.0) { return Err("forecast horizon must be up to 6 hours".into()); }
    if decay_tau_s.is_nan() || decay_tau_s <= 0.0 { return Err("decay time must be positive (or infinite for none)".into()); }
    let motion = if frames.len() >= 2 { estimate_motion(frames, grid, step_s, max_speed_m_s)? } else {
        check(frames, grid, step_s)?;
        Motion { u_m_s: 0.0, v_m_s: 0.0, correlation: 0.0, reliable: false }
    };
    let last = frames.last().ok_or("no radar frames")?;
    let n = (horizon_s / step_s - 1e-9).ceil() as usize;
    let (mut out, mut known) = (Vec::with_capacity(n), Vec::with_capacity(n));
    for k in 0..n {
        let lead = (k as f64 + 0.5) * step_s;
        let mut f = advect(last, grid, &motion, lead)?;
        let fade = if decay_tau_s.is_finite() { (-lead / decay_tau_s).exp() as f32 } else { 1.0 };
        for v in f.iter_mut() { *v *= fade; }
        known.push(f.iter().filter(|v| v.is_finite()).count() as f64 / f.len() as f64);
        out.push(f);
    }
    Ok(Nowcast { frames: out, known_share: known, motion })
}

/// The same forecast with every rate multiplied by `factor` (rates stay 0 to 1000 mm/h), for the
/// lighter and heavier what-if runs. NaN stays NaN.
pub fn scaled(frames: &[Vec<f32>], factor: f64) -> Result<Vec<Vec<f32>>, String> {
    if !(factor.is_finite() && factor >= 0.0) { return Err("scale must be a number from 0".into()); }
    // f64::min would turn a NaN into the cap, and unknown rain must not become the heaviest rain
    Ok(frames.iter().map(|f| f.iter().map(|v| if v.is_nan() { f32::NAN } else { (*v as f64 * factor).min(crate::flash::MAX_RATE) as f32 }).collect()).collect())
}

/// How the forecast at one lead compares with simply keeping the latest frame ("persistence").
#[derive(Clone, Debug)]
pub struct LeadSkill {
    pub lead_s: f64,
    /// Origins that contributed.
    pub cases: usize,
    /// Root-mean-square error (mm/h) over the cells where the forecast is known, pooled over all origins.
    pub rmse_nowcast: f64,
    pub rmse_persistence: f64,
    /// `1 - rmse_nowcast / rmse_persistence`: above 0 beats persistence, 1 is perfect, NaN if persistence is perfect.
    pub skill: f64,
    /// Forecast rain over observed rain (1 = unbiased), pooled; NaN if none was observed.
    pub bias_ratio: f64,
    pub thresholds: Vec<ThresholdSkill>,
}

/// Yes/no skill for "rain at least this heavy", pooled over cells and origins.
#[derive(Clone, Debug)]
pub struct ThresholdSkill {
    pub mm_h: f32,
    /// Critical success index (hits / (hits + misses + false alarms)): 1 is perfect, NaN if nothing was observed or forecast.
    pub csi_nowcast: f64,
    pub csi_persistence: f64,
    /// Probability of detection and false-alarm ratio for the nowcast.
    pub pod: f64,
    pub far: f64,
}

#[derive(Clone, Debug)]
pub struct SkillReport {
    pub step_s: f64,
    pub origins_used: usize,
    /// Origins skipped because the latest frame or the one after had too little rain to match or score.
    pub origins_dry: usize,
    /// Origins skipped because a frame they needed had a missing or negative cell.
    pub origins_gappy: usize,
    /// Share of the origins used whose motion could be estimated.
    pub motion_reliable_share: f64,
    pub leads: Vec<LeadSkill>,
}

#[derive(Default, Clone)]
struct Tally { se_now: f64, se_per: f64, n: f64, sum_fc: f64, sum_obs: f64, cases: usize, hits: Vec<[f64; 6]> }

/// Score the forecast against persistence on archived frames.
///
/// `runs` are stretches of consecutive frames at spacing `step_s`, oldest first (split an archive wherever
/// frames are missing). At each origin the forecast uses the `history` frames up to it and is carried to
/// leads of 1 to `max_lead` steps (instants, not step middles), then compared with the frame that really
/// came at that lead. Persistence is the origin frame itself. An origin is skipped if its frames have a
/// missing cell or if neither the origin nor the frame it is scored against has enough rain; origins
/// where the forecast has unknown cells are scored on the known cells only.
pub fn score(runs: &[&[Vec<f32>]], grid: &RadarGrid, step_s: f64, history: usize, max_lead: usize, thresholds: &[f32], max_speed_m_s: f64) -> Result<SkillReport, String> {
    if history < 2 { return Err("scoring needs at least two history frames".into()); }
    if max_lead == 0 || max_lead > 36 { return Err("leads go from 1 to 36 steps".into()); }
    if thresholds.iter().any(|t| !t.is_finite() || *t <= 0.0) { return Err("thresholds must be positive".into()); }
    if !(step_s.is_finite() && step_s > 0.0) { return Err("frame spacing must be positive".into()); }
    let mut tallies: Vec<Tally> = (0..max_lead).map(|_| Tally { hits: vec![[0.0; 6]; thresholds.len()], ..Tally::default() }).collect();
    let (mut used, mut dry, mut gappy, mut reliable) = (0usize, 0usize, 0usize, 0usize);
    let good = |f: &Vec<f32>| f.len() == grid.w * grid.h && f.iter().all(|v| v.is_finite() && *v >= 0.0);
    let rainy = |f: &Vec<f32>| f.iter().filter(|v| **v >= RAIN_MM_H).count() >= MIN_RAINY_CELLS;
    for run in runs {
        for o in (history - 1)..run.len() {
            let window = &run[o + 1 - history..=(o + max_lead).min(run.len() - 1)];
            if window.iter().any(|f| !good(f)) { gappy += 1; continue; }
            if o + 1 >= run.len() { continue; }   // no future frame to score against
            let hist = &run[o + 1 - history..=o];
            if !rainy(&run[o]) { dry += 1; continue; }
            let motion = estimate_motion(hist, grid, step_s, max_speed_m_s)?;
            used += 1; if motion.reliable { reliable += 1; }
            for j in 1..=max_lead.min(run.len() - 1 - o) {
                let truth = &run[o + j];
                let fc = advect(&run[o], grid, &motion, j as f64 * step_s)?;
                let t = &mut tallies[j - 1];
                t.cases += 1;
                for (i, f) in fc.iter().enumerate() {
                    if !f.is_finite() { continue; }
                    let (tv, pv) = (truth[i], run[o][i]);
                    t.se_now += ((*f - tv) as f64).powi(2); t.se_per += ((pv - tv) as f64).powi(2); t.n += 1.0;
                    t.sum_fc += *f as f64; t.sum_obs += tv as f64;
                    for (k, th) in thresholds.iter().enumerate() {
                        let (obs, now, per) = (tv >= *th, *f >= *th, pv >= *th);
                        let h = &mut t.hits[k];
                        if obs && now { h[0] += 1.0 } else if obs { h[1] += 1.0 } else if now { h[2] += 1.0 }
                        if obs && per { h[3] += 1.0 } else if obs { h[4] += 1.0 } else if per { h[5] += 1.0 }
                    }
                }
            }
        }
    }
    let ratio = |a: f64, b: f64| if b > 0.0 { a / b } else { f64::NAN };
    let leads = tallies.iter().enumerate().filter(|(_, t)| t.cases > 0).map(|(j, t)| {
        let (rn, rp) = ((t.se_now / t.n).sqrt(), (t.se_per / t.n).sqrt());
        LeadSkill { lead_s: (j + 1) as f64 * step_s, cases: t.cases, rmse_nowcast: rn, rmse_persistence: rp, skill: if rp > 0.0 { 1.0 - rn / rp } else { f64::NAN }, bias_ratio: ratio(t.sum_fc, t.sum_obs),
            thresholds: thresholds.iter().zip(&t.hits).map(|(th, h)| ThresholdSkill { mm_h: *th, csi_nowcast: ratio(h[0], h[0] + h[1] + h[2]), csi_persistence: ratio(h[3], h[3] + h[4] + h[5]),
                pod: ratio(h[0], h[0] + h[1]), far: ratio(h[2], h[0] + h[2]) }).collect() }
    }).collect();
    Ok(SkillReport { step_s, origins_used: used, origins_dry: dry, origins_gappy: gappy, motion_reliable_share: if used > 0 { reliable as f64 / used as f64 } else { f64::NAN }, leads })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::radar::{observed_field, TargetGrid};
    use crate::util::Mulberry32;

    const N: usize = 64;
    fn grid() -> RadarGrid { RadarGrid { w: N, h: N, x0: 0.0, y0: 0.0, dx: 1000.0, dy: 1000.0 } }
    /// Two rain cells of different size, centred at (cx, cy) cells, so the pattern is not symmetric.
    fn storm(cx: f64, cy: f64) -> Vec<f32> {
        (0..N * N).map(|k| {
            let (x, y) = ((k % N) as f64 + 0.5, (k / N) as f64 + 0.5);
            let g = |px: f64, py: f64, s: f64, a: f64| a * (-((x - px).powi(2) + (y - py).powi(2)) / (2.0 * s * s)).exp();
            (g(cx, cy, 3.5, 40.0) + g(cx + 9.0, cy + 4.0, 2.0, 25.0)) as f32
        }).collect()
    }
    /// A storm that moves (vx, vy) cells per frame, frames 0..n, starting at (x0, y0).
    fn moving(n: usize, x0: f64, y0: f64, vx: f64, vy: f64) -> Vec<Vec<f32>> { (0..n).map(|k| storm(x0 + vx * k as f64, y0 + vy * k as f64)).collect() }
    fn rmse(a: &[f32], b: &[f32]) -> f64 { (a.iter().zip(b).filter(|(x, _)| x.is_finite()).map(|(x, y)| ((*x - *y) as f64).powi(2)).sum::<f64>() / a.len() as f64).sqrt() }

    #[test]
    fn it_recovers_a_whole_and_a_fractional_cell_motion() {
        for (vx, vy) in [(2.0, 0.0), (1.5, 0.5), (-1.0, 1.25), (0.0, -2.0)] {
            let frames = moving(4, 24.0, 28.0, vx, vy);
            let m = estimate_motion(&frames, &grid(), 600.0, 30.0).unwrap();
            let (u, v) = (vx * 1000.0 / 600.0, vy * 1000.0 / 600.0);
            assert!(m.reliable && m.correlation > 0.9, "{m:?}");
            assert!((m.u_m_s - u).abs() < 0.15 * 1000.0 / 600.0 && (m.v_m_s - v).abs() < 0.15 * 1000.0 / 600.0, "({vx},{vy}): got ({}, {}) m/s, want ({u}, {v})", m.u_m_s, m.v_m_s);
        }
    }

    #[test]
    fn still_rain_reads_as_still_and_dry_frames_are_unreliable_not_wrong() {
        let still = vec![storm(30.0, 30.0); 3];
        let m = estimate_motion(&still, &grid(), 600.0, 30.0).unwrap();
        assert!(m.reliable && m.u_m_s.abs() < 1e-9 && m.v_m_s.abs() < 1e-9, "{m:?}");
        let dry = vec![vec![0.0f32; N * N]; 3];
        let m = estimate_motion(&dry, &grid(), 600.0, 30.0).unwrap();
        assert!(!m.reliable && m.u_m_s == 0.0 && m.v_m_s == 0.0);
        let n = nowcast(&dry, &grid(), 600.0, 3600.0, f64::INFINITY, 30.0).unwrap();
        assert!(n.frames.iter().all(|f| f.iter().all(|v| *v == 0.0)), "dry stays dry");
        // a pair that does not look alike (the rain jumped) is not trusted
        let jump = vec![storm(10.0, 10.0), storm(50.0, 50.0)];
        let m = estimate_motion(&jump, &grid(), 600.0, 30.0).unwrap();
        assert!(!m.reliable, "{m:?}");
    }

    #[test]
    fn it_beats_persistence_and_keeps_the_peak_on_a_translating_storm() {
        let frames = moving(5, 14.0, 20.0, 1.5, 0.5);
        let g = grid();
        let n = nowcast(&frames, &g, 600.0, 3600.0, f64::INFINITY, 30.0).unwrap();
        assert_eq!(n.frames.len(), 6);
        for (k, f) in n.frames.iter().enumerate() {
            // frame k stands for the middle of its step: (k + 0.5) steps after the last frame (index 4)
            let truth = storm(14.0 + 1.5 * (4.0 + k as f64 + 0.5), 20.0 + 0.5 * (4.0 + k as f64 + 0.5));
            let persistence = &frames[4];
            let (e_now, e_per) = (rmse(f, &truth), rmse(persistence, &truth));
            assert!(e_now < 0.25 * e_per, "step {k}: nowcast error {e_now:.3} vs persistence {e_per:.3}");
            let peak = f.iter().copied().filter(|v| v.is_finite()).fold(0.0, f32::max);
            assert!(peak > 0.85 * 40.0 && peak < 1.05 * 40.0, "step {k}: the peak {peak} stays near 40 mm/h");
        }
    }

    #[test]
    fn it_survives_noise_and_say_what_it_does_not_know() {
        let mut rng = Mulberry32::new(7);
        let noisy: Vec<Vec<f32>> = moving(4, 20.0, 30.0, 2.0, 0.0).into_iter()
            .map(|f| f.into_iter().map(|v| (v as f64 * (1.0 + 0.3 * (rng.next_f64() - 0.5)) + 0.5 * rng.next_f64()) as f32).collect()).collect();
        let m = estimate_motion(&noisy, &grid(), 600.0, 30.0).unwrap();
        assert!(m.reliable && (m.u_m_s - 2.0 * 1000.0 / 600.0).abs() < 0.4 && m.v_m_s.abs() < 0.4, "{m:?}");
        // moving east at 2 cells a frame, the first 2 cells upwind of the west edge are unknown at +1 step (about 2.5 cells), growing with lead
        let n = nowcast(&moving(4, 20.0, 30.0, 2.0, 0.0), &grid(), 600.0, 3600.0, f64::INFINITY, 30.0).unwrap();
        assert!(n.known_share.windows(2).all(|p| p[1] < p[0]), "less is known the further ahead: {:?}", n.known_share);
        assert!((n.known_share[0] - (1.0 - 1.0 / 64.0 * 1.0)).abs() < 0.04, "{:?}", n.known_share);
        assert!(n.frames[5].iter().any(|v| v.is_nan()), "unknown cells are NaN, not dry");
        // still rain is fully known at every lead
        let s = nowcast(&vec![storm(30.0, 30.0); 3], &grid(), 600.0, 1800.0, f64::INFINITY, 30.0).unwrap();
        assert!(s.known_share.iter().all(|k| *k == 1.0));
    }

    #[test]
    fn decay_fades_the_rain_and_scenarios_scale_it() {
        let frames = vec![storm(30.0, 30.0); 3];
        let plain = nowcast(&frames, &grid(), 600.0, 3600.0, f64::INFINITY, 30.0).unwrap();
        let fading = nowcast(&frames, &grid(), 600.0, 3600.0, 1800.0, 30.0).unwrap();
        let mean = |f: &Vec<f32>| f.iter().sum::<f32>() / f.len() as f32;
        // step 5 is centred 55 minutes ahead: exp(-3300/1800) of the still rain
        let want = (-(5.5 * 600.0) / 1800.0f64).exp();
        assert!(((mean(&fading.frames[5]) / mean(&plain.frames[5])) as f64 - want).abs() < 1e-4);
        assert!(mean(&fading.frames[0]) > mean(&fading.frames[5]));
        let heavy = scaled(&plain.frames, 1.4).unwrap();
        assert!((mean(&heavy[0]) / mean(&plain.frames[0]) - 1.4).abs() < 1e-5);
        assert!(scaled(&plain.frames, 100.0).unwrap().iter().flatten().all(|v| *v <= 1000.0));
        assert!(scaled(&plain.frames, -1.0).is_err());
        let nan = vec![vec![f32::NAN, 1.0]];
        assert!(scaled(&nan, 2.0).unwrap()[0][0].is_nan());
    }

    #[test]
    fn scoring_shows_skill_on_a_translating_storm_and_none_on_a_storm_that_changes_shape() {
        let g = grid();
        // a long steady storm: the forecast should beat persistence at every lead
        let frames = moving(14, 6.0, 30.0, 1.5, 0.0);
        let r = score(&[&frames], &g, 600.0, 4, 4, &[1.0, 10.0], 30.0).unwrap();
        assert!(r.origins_used >= 5 && r.motion_reliable_share > 0.99 && r.origins_gappy == 0);
        assert_eq!(r.leads.len(), 4);
        for l in &r.leads {
            assert!(l.skill > 0.7, "lead {}: skill {} (nowcast {} vs persistence {})", l.lead_s, l.skill, l.rmse_nowcast, l.rmse_persistence);
            assert!((l.bias_ratio - 1.0).abs() < 0.15, "bias {}", l.bias_ratio);
            let t = &l.thresholds[1];
            assert!(t.csi_nowcast > t.csi_persistence, "CSI at 10 mm/h: {} vs {}", t.csi_nowcast, t.csi_persistence);
            assert!(t.pod > 0.7 && t.far < 0.3, "pod {} far {}", t.pod, t.far);
        }
        // a storm whose rain keeps jumping somewhere new cannot be forecast: the forecast is not better than persistence
        let jumpy: Vec<Vec<f32>> = (0..14).map(|k| storm(10.0 + ((k * 23) % 44) as f64, 12.0 + ((k * 37) % 40) as f64)).collect();
        let j = score(&[&jumpy], &g, 600.0, 3, 3, &[10.0], 30.0).unwrap();
        assert!(j.leads.iter().all(|l| l.skill.is_nan() || l.skill <= 0.2), "no skill claimed on rain that jumps: {:?}", j.leads.iter().map(|l| l.skill).collect::<Vec<_>>());
    }

    #[test]
    fn scoring_counts_what_it_skips_and_pools_runs() {
        let g = grid();
        let good = moving(8, 8.0, 30.0, 1.5, 0.0);
        let mut gappy = good.clone(); gappy[4][100] = f32::NAN;
        let a = score(&[&good], &g, 600.0, 3, 2, &[1.0], 30.0).unwrap();
        let b = score(&[&gappy], &g, 600.0, 3, 2, &[1.0], 30.0).unwrap();
        assert!(b.origins_gappy > 0 && b.origins_used < a.origins_used, "{} vs {}", b.origins_used, a.origins_used);
        let dry = vec![vec![0.0f32; N * N]; 8];
        let d = score(&[&dry], &g, 600.0, 3, 2, &[1.0], 30.0).unwrap();
        assert_eq!(d.origins_used, 0); assert!(d.origins_dry > 0 && d.leads.is_empty() && d.motion_reliable_share.is_nan());
        // two runs pool: more cases than one
        let two = score(&[&good, &good], &g, 600.0, 3, 2, &[1.0], 30.0).unwrap();
        assert_eq!(two.origins_used, 2 * a.origins_used);
        assert!((two.leads[0].rmse_nowcast - a.leads[0].rmse_nowcast).abs() < 1e-9, "the same case twice scores the same");
        // refusals
        assert!(score(&[&good], &g, 600.0, 1, 2, &[1.0], 30.0).is_err());
        assert!(score(&[&good], &g, 600.0, 3, 0, &[1.0], 30.0).is_err());
        assert!(score(&[&good], &g, 600.0, 3, 2, &[-1.0], 30.0).is_err());
        assert!(score(&[&good], &g, 0.0, 3, 2, &[1.0], 30.0).is_err());
    }

    #[test]
    fn bad_inputs_are_refused() {
        let g = grid();
        let ok = vec![storm(30.0, 30.0); 2];
        assert!(estimate_motion(&ok[..1], &g, 600.0, 30.0).is_err(), "one frame cannot show motion");
        assert!(estimate_motion(&ok, &g, 0.0, 30.0).is_err());
        assert!(estimate_motion(&ok, &g, 600.0, -1.0).is_err());
        assert!(estimate_motion(&[vec![1.0; 5], vec![1.0; 5]], &g, 600.0, 30.0).is_err(), "wrong size");
        let mut gap = ok.clone(); gap[1][10] = f32::NAN;
        assert!(estimate_motion(&gap, &g, 600.0, 30.0).unwrap_err().contains("missing"), "a gap is not filled with rain or dryness");
        assert!(nowcast(&ok, &g, 600.0, 0.0, f64::INFINITY, 30.0).is_err());
        assert!(nowcast(&ok, &g, 600.0, 7.0 * 3600.0, f64::INFINITY, 30.0).is_err());
        assert!(nowcast(&ok, &g, 600.0, 3600.0, 0.0, 30.0).is_err());
        assert!(nowcast(&[], &g, 600.0, 3600.0, f64::INFINITY, 30.0).is_err());
        // a single frame is allowed: persistence, flagged unreliable
        let one = nowcast(&ok[..1], &g, 600.0, 1200.0, f64::INFINITY, 30.0).unwrap();
        assert!(!one.motion.reliable && one.frames.len() == 2);
    }

    #[test]
    fn a_forecast_becomes_a_solver_rain_field() {
        // the forecast, on the radar grid, resampled to a 500 m solver grid over the middle 16 km of the radar
        let frames = moving(5, 20.0, 28.0, 1.0, 0.0);
        let g = grid();
        let n = nowcast(&frames, &g, 600.0, 3600.0, f64::INFINITY, 30.0).unwrap();
        let t = TargetGrid { w: 32, h: 32, x0: 24_000.0, y0: 24_000.0, cell: 500.0 };
        let field = observed_field(&g, &n.frames, 600.0, &t, 0.99).unwrap();
        assert_eq!(field.frames.len(), 6);
        assert!(field.validate(32 * 32).is_ok());
        assert!(field.frames.iter().all(|f| f.iter().all(|v| v.is_finite() && *v >= 0.0)));
        // the rain is heavier somewhere in the window and has moved east by the last frame
        let col_of_max = |f: &Vec<f32>| f.iter().position(|v| *v == f.iter().copied().fold(0.0, f32::max)).unwrap() % 32;
        assert!(col_of_max(&field.frames[5]) >= col_of_max(&field.frames[0]));
    }
}
