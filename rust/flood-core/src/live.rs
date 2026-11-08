//! A "live storm" for a model area: the last hour or so of observed radar followed by a short forecast,
//! as the rain field the 2D solver runs, with the ground's losses taken off cell by cell.
//!
//! The radar frames come from the broker's `/v1/radar` (rust/flood-broker/src/radar.rs) on a north-up
//! grid in an MGA zone. The area is the page's: a latitude and longitude box cut into `w` x `h` cells.
//! Each cell's centre is projected into the radar's grid, so the rain lands on the right ground whatever
//! the zone's grid convergence.
//!
//! Timeline. Frames are instants, oldest first, the last being "now". Frame k holds for the step after
//! its time, so the observed part is every frame but the last (the interval from the first frame to
//! now), and the forecast ([`crate::nowcast`]) starts at now. Dry frames follow so the water can drain.
//! Nothing here fills a gap: a frame with a cell the radar did not measure is refused, so missing data
//! is never run as dry weather.
use crate::geo::to_mga;
use crate::nowcast::{nowcast, scaled, Motion};
use crate::radar::{observed_field_at, RadarGrid};
use crate::rainfield::{apply_losses, RainField};

/// Frames as the broker serves them, after the page has joined them end to end.
pub struct LiveRadar {
    pub w: usize,
    pub h: usize,
    /// Easting and northing of the top-left corner (m), and the cell size (m): columns step east, rows step south.
    pub x0: f64,
    pub y0_northing: f64,
    pub dx: f64,
    pub dy: f64,
    pub step_s: f64,
    /// All frames, oldest first, one after another: tenths of mm/h, -1 for a cell that was not measured.
    pub frames_tenths: Vec<f64>,
}

/// The model area: a latitude/longitude box divided into `w` x `h` cells, and the MGA zone the radar uses.
pub struct LiveArea { pub w: usize, pub h: usize, pub west: f64, pub east: f64, pub north: f64, pub south: f64, pub zone: i32 }

pub struct LiveParams {
    /// How far to forecast (s), up to 6 hours.
    pub horizon_s: f64,
    /// Fade time constant for the forecast rain (s); infinity for none.
    pub decay_tau_s: f64,
    /// Multiplies the forecast rain only (1 = as forecast), for lighter and heavier what-ifs.
    pub scale: f64,
    pub initial_loss_mm: f64,
    pub continuing_mm_h: f64,
    /// Hours of dry frames after the forecast, for the water to drain (at least one frame).
    pub after_hours: f64,
    /// Fastest storm motion searched (m/s).
    pub max_speed_m_s: f64,
    /// The least share of the area the radar must cover (0 to 1).
    pub min_coverage: f64,
}

pub struct LiveStorm {
    /// The rain left after losses, per cell per step, observed then forecast then dry.
    pub field: RainField,
    pub motion: Motion,
    /// Frames of observed rain, and of forecast rain, in the field.
    pub observed_steps: usize,
    pub forecast_steps: usize,
    /// The least share of the forecast's cells that were known before edge cells were filled from their neighbours.
    pub min_known_share: f64,
    /// Rain over the area (mm, averaged over its cells) in the observed part and in the forecast part, before losses.
    pub observed_rain_mm: f64,
    pub forecast_rain_mm: f64,
    /// All the rain left after losses, averaged over the area (mm).
    pub runoff_mm: f64,
}

/// The cell centres of the area in the radar's coordinates (easting, and northing negated so that rows go south).
pub fn area_points(a: &LiveArea) -> Result<Vec<(f64, f64)>, String> {
    if !(49..=58).contains(&a.zone) { return Err("the radar's MGA zone must be 49 to 58".into()); }
    if a.w == 0 || a.h == 0 || !(a.east > a.west && a.north > a.south) || ![a.west, a.east, a.north, a.south].iter().all(|v| v.is_finite()) {
        return Err("the area needs cells and a latitude and longitude box".into());
    }
    let mut pts = Vec::with_capacity(a.w * a.h);
    for j in 0..a.h {
        let lat = a.north - (j as f64 + 0.5) / a.h as f64 * (a.north - a.south);
        for i in 0..a.w {
            let lon = a.west + (i as f64 + 0.5) / a.w as f64 * (a.east - a.west);
            let (e, n) = to_mga(lat, lon, a.zone);
            pts.push((e, -n));
        }
    }
    Ok(pts)
}

/// Build the live storm for an area. See the module notes for the timeline.
pub fn live_storm(radar: &LiveRadar, area: &LiveArea, p: &LiveParams) -> Result<LiveStorm, String> {
    let cells = radar.w * radar.h;
    if cells == 0 || radar.frames_tenths.is_empty() || !radar.frames_tenths.len().is_multiple_of(cells) { return Err("radar frames must be a whole number of grid-sized frames".into()); }
    let m = radar.frames_tenths.len() / cells;
    if m < 2 { return Err("a live storm needs at least two radar frames (the last is now)".into()); }
    if !(radar.step_s.is_finite() && (60.0..=3600.0).contains(&radar.step_s)) { return Err("radar frames must be 1 to 60 minutes apart".into()); }
    if !(p.after_hours.is_finite() && (0.0..=6.0).contains(&p.after_hours)) { return Err("the run can continue for up to 6 hours after the forecast".into()); }
    let grid = RadarGrid { w: radar.w, h: radar.h, x0: radar.x0, y0: -radar.y0_northing, dx: radar.dx, dy: radar.dy };
    let mut frames: Vec<Vec<f32>> = Vec::with_capacity(m);
    for (k, f) in radar.frames_tenths.chunks(cells).enumerate() {
        let missing = f.iter().filter(|v| !v.is_finite() || **v < 0.0).count();
        if missing > 0 { return Err(format!("radar frame {k} has {missing} cells with no measurement; a live storm needs complete frames")); }
        frames.push(f.iter().map(|v| (*v / 10.0) as f32).collect());
    }
    let points = area_points(area)?;
    let (w, h) = (area.w, area.h);

    // observed: every frame but the last, each holding for one step
    let observed = observed_field_at(&grid, &frames[..m - 1], radar.step_s, &points, w, h, p.min_coverage)?;
    // forecast from the last frame
    let nc = nowcast(&frames, &grid, radar.step_s, p.horizon_s, p.decay_tau_s, p.max_speed_m_s)?;
    let heavy = scaled(&nc.frames, p.scale)?;
    let forecast = observed_field_at(&grid, &heavy, radar.step_s, &points, w, h, p.min_coverage)?;
    let min_known_share = nc.known_share.iter().copied().fold(1.0, f64::min);

    let after = ((p.after_hours * 3600.0 / radar.step_s).round() as usize).max(1);
    let mut raw = RainField { step_s: radar.step_s, frames: observed.frames.clone() };
    raw.frames.extend(forecast.frames.iter().cloned());
    raw.frames.extend(std::iter::repeat_n(vec![0.0_f32; w * h], after));
    raw.validate(w * h)?;
    let net = apply_losses(&raw, p.initial_loss_mm, p.continuing_mm_h)?;
    let mean = |f: &RainField, from: usize, to: usize| {
        (0..w * h).map(|c| f.frames[from..to].iter().map(|fr| fr[c] as f64).sum::<f64>()).sum::<f64>() * radar.step_s / 3600.0 / (w * h) as f64
    };
    let (o, f) = (observed.frames.len(), forecast.frames.len());
    Ok(LiveStorm {
        motion: nc.motion, observed_steps: o, forecast_steps: f, min_known_share,
        observed_rain_mm: mean(&raw, 0, o), forecast_rain_mm: mean(&raw, o, o + f), runoff_mm: mean(&net, 0, net.frames.len()), field: net,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::from_mga;

    const N: usize = 100;
    const ZONE: i32 = 56;
    /// A 100 x 100 km radar of 1 km cells with its top-left corner at (450 000 E, 7 010 000 N): Brisbane is inside it.
    fn radar(frames: Vec<Vec<f32>>) -> LiveRadar {
        LiveRadar { w: N, h: N, x0: 450_000.0, y0_northing: 7_010_000.0, dx: 1000.0, dy: 1000.0, step_s: 600.0,
            frames_tenths: frames.into_iter().flatten().map(|v| (v * 10.0).round() as f64).collect() }
    }
    /// A rain cell of 40 mm/h centred at (e, n) metres, sigma 3 km, drawn on that grid.
    fn blob(e: f64, n: f64) -> Vec<f32> {
        (0..N * N).map(|k| {
            let (ce, cn) = (450_000.0 + ((k % N) as f64 + 0.5) * 1000.0, 7_010_000.0 - ((k / N) as f64 + 0.5) * 1000.0);
            (40.0 * (-((ce - e).powi(2) + (cn - n).powi(2)) / (2.0 * 3000.0 * 3000.0)).exp()) as f32
        }).collect()
    }
    /// A 10 km box of 40 x 40 cells centred on the MGA point (e, n).
    fn area_at(e: f64, n: f64) -> LiveArea {
        let (s, w) = from_mga(e - 5000.0, n - 5000.0, ZONE);
        let (no, ea) = from_mga(e + 5000.0, n + 5000.0, ZONE);
        LiveArea { w: 40, h: 40, west: w, east: ea, north: no, south: s, zone: ZONE }
    }
    fn params() -> LiveParams {
        LiveParams { horizon_s: 3600.0, decay_tau_s: f64::INFINITY, scale: 1.0, initial_loss_mm: 0.0, continuing_mm_h: 0.0, after_hours: 1.0, max_speed_m_s: 25.0, min_coverage: 0.9 }
    }

    #[test]
    fn rain_lands_on_the_right_ground_north_is_up_and_east_is_right() {
        // still rain centred on a radar cell 2.5 km east and 1.5 km north of the area's middle: the wettest cell must be there
        let (e0, n0) = (500_000.0, 6_960_000.0);
        let still = blob(e0 + 2500.0, n0 + 1500.0);
        let s = live_storm(&radar(vec![still.clone(), still.clone(), still]), &area_at(e0, n0), &params()).unwrap();
        let f = &s.field.frames[0];
        let best = f.iter().position(|v| *v == f.iter().copied().fold(0.0, f32::max)).unwrap();
        let (col, row) = (best % 40, best / 40);
        // cell size 250 m: 2.5 km east of the middle is column 20 + 10, 1.5 km north is row 20 - 6 (rows run south)
        assert!((col as i64 - 30).abs() <= 1, "column {col}");
        assert!((row as i64 - 14).abs() <= 1, "row {row}");
    }

    #[test]
    fn a_moving_storm_is_observed_then_forecast_then_dry() {
        // the storm moves 1.5 cells (1.5 km) east every 10 minutes
        let frames: Vec<Vec<f32>> = (0..7).map(|k| blob(480_000.0 + 1500.0 * k as f64, 6_960_000.0)).collect();
        let s = live_storm(&radar(frames), &area_at(500_000.0, 6_960_000.0), &params()).unwrap();
        assert_eq!(s.observed_steps, 6); assert_eq!(s.forecast_steps, 6);
        assert_eq!(s.field.frames.len(), 6 + 6 + 6, "observed + forecast + an hour dry");
        assert_eq!(s.field.step_s, 600.0);
        assert!(s.motion.reliable);
        assert!((s.motion.u_m_s - 2.5).abs() < 0.2 && s.motion.v_m_s.abs() < 0.2, "{:?}", s.motion);
        assert!(s.field.frames[12..].iter().all(|f| f.iter().all(|v| *v == 0.0)), "dry at the end");
        // the storm is west of the area at first, crosses it, and has left to the east
        let total = |k: usize| s.field.frames[k].iter().map(|v| *v as f64).sum::<f64>();
        assert!(total(0) < total(5) || total(5) < total(9), "the rain arrives and passes: {} {} {}", total(0), total(5), total(9));
        let peak_col = |k: usize| { let f = &s.field.frames[k]; let m = f.iter().copied().fold(0.0, f32::max); f.iter().position(|v| *v == m).unwrap() % 40 };
        assert!(peak_col(11) > peak_col(6), "the forecast carries it east: {} then {}", peak_col(6), peak_col(11));
        assert!(s.observed_rain_mm > 0.0 && s.forecast_rain_mm > 0.0 && (s.runoff_mm - (s.observed_rain_mm + s.forecast_rain_mm)).abs() < 1e-3, "no losses: runoff is all the rain");
        assert!(s.min_known_share > 0.9);
    }

    #[test]
    fn losses_scale_and_decay_apply_as_asked() {
        let frames: Vec<Vec<f32>> = (0..4).map(|_| blob(500_000.0, 6_960_000.0)).collect();
        let a = area_at(500_000.0, 6_960_000.0);
        let plain = live_storm(&radar(frames.clone()), &a, &params()).unwrap();
        let lossy = live_storm(&radar(frames.clone()), &a, &LiveParams { initial_loss_mm: 5.0, continuing_mm_h: 1.0, ..params() }).unwrap();
        assert!(lossy.runoff_mm < plain.runoff_mm);
        let heavy = live_storm(&radar(frames.clone()), &a, &LiveParams { scale: 2.0, ..params() }).unwrap();
        assert!((heavy.forecast_rain_mm / plain.forecast_rain_mm - 2.0).abs() < 1e-3 && (heavy.observed_rain_mm - plain.observed_rain_mm).abs() < 1e-9, "scale touches only the forecast");
        let fading = live_storm(&radar(frames), &a, &LiveParams { decay_tau_s: 1800.0, ..params() }).unwrap();
        assert!(fading.forecast_rain_mm < plain.forecast_rain_mm * 0.8);
    }

    #[test]
    fn missing_cells_gaps_and_bad_inputs_are_refused_not_run_as_dry() {
        let ok: Vec<Vec<f32>> = (0..3).map(|_| blob(500_000.0, 6_960_000.0)).collect();
        let a = area_at(500_000.0, 6_960_000.0);
        let mut gap = radar(ok.clone()); gap.frames_tenths[N * N + 5] = -1.0;
        let e = live_storm(&gap, &a, &params()).err().unwrap();
        assert!(e.contains("frame 1") && e.contains("no measurement"), "{e}");
        assert!(live_storm(&radar(ok[..1].to_vec()), &a, &params()).is_err(), "needs two frames");
        let mut bad_zone = area_at(500_000.0, 6_960_000.0); bad_zone.zone = 12;
        assert!(live_storm(&radar(ok.clone()), &bad_zone, &params()).is_err());
        let mut step = radar(ok.clone()); step.step_s = 5.0;
        assert!(live_storm(&step, &a, &params()).is_err());
        // an area outside the radar is refused rather than padded
        let far = area_at(900_000.0, 6_000_000.0);
        let e = live_storm(&radar(ok.clone()), &far, &params()).err().unwrap();
        assert!(e.contains("covers only"), "{e}");
        assert!(live_storm(&radar(ok), &a, &LiveParams { after_hours: 9.0, ..params() }).is_err());
    }
}
