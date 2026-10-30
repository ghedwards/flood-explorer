//! One-way nesting of a local nonlinear model inside a regional propagation model. The regional run records the surface displacement along the local model's open sea
//! edges (`nest::plan_geographic` chooses where, and scales to the local depth by Green's law); here that recording, or a wave series someone supplies, becomes the incoming-wave
//! forcing the local solver takes at its open edges, with an optional rising tide on top. Not two-way (see `nest`): the local model does not feed back, and the regional run is
//! linear on a 1.5 km grid with coastal depths floored at 10 m, so the forced signal is only as good as the regional solution at the handover points.

use crate::inundation::Edge;
use crate::nest::Plan;

/// A regional recording: surface displacement at the plan's points, row-major [sample][point].
#[derive(Clone)]
pub struct Recording { pub times: Vec<f64>, pub values: Vec<f64>, pub points: usize }

/// What one open edge is driven with.
#[derive(Debug)]
pub struct EdgeForcing { pub edge: Edge, pub points: usize, pub series: Vec<f64>, pub peak: f64, pub snapped: usize }

#[derive(Debug)]
pub struct Forcing {
    /// Local seconds of every sample.
    pub times: Vec<f64>,
    /// Regional time at which the local clock reads zero (0 for a series).
    pub offset: f64,
    /// When the wave first passes the threshold at any handover point, in the clock the times are measured from: regional time for a recording, local time for a series.
    pub arrival: f64,
    pub peak: f64,
    pub edges: Vec<EdgeForcing>,
}

/// Turn the regional recording into solver forcing. Local time 0 is placed `lead` seconds before the wave first exceeds `threshold` of its peak at any handover point, so the
/// local model does not spend its run waiting.
pub fn forcing_from_recording(plan: &Plan, rec: &Recording, lead: f64, threshold: f64, max_local_seconds: f64) -> Result<Forcing, String> {
    let (times, points) = (&rec.times, rec.points);
    if points != plan.points.len() || rec.values.len() != times.len() * points { return Err("the regional recording does not match the coupling plan".into()); }
    let mut scaled = vec![0.0; rec.values.len()];
    let mut peak = 0.0_f64;
    for e in &plan.edges {
        for k in 0..e.count {
            for s in 0..times.len() {
                let i = s * points + e.first + k;
                let v = rec.values[i] * plan.gains[e.first + k];
                scaled[i] = v;
                peak = peak.max(v.abs());
            }
        }
    }
    if peak <= 1e-4 { return Err("the offshore wave never reaches the local model within the regional run; extend the length, move the source or raise its strength".into()); }
    let mut arrival = times.len() - 1;
    'search: for s in 0..times.len() { for p in 0..points { if scaled[s * points + p].abs() > threshold * peak { arrival = s; break 'search; } } }
    let start = (times[arrival] - lead).max(0.0);
    let first = times.iter().position(|t| *t > start).map_or(0, |k| k.saturating_sub(1));
    let spacing = if times.len() > 1 { times[1] - times[0] } else { 0.0 };
    let keep: Vec<usize> = (first..times.len()).take_while(|s| times[*s] - start <= max_local_seconds + 2.0 * spacing).collect();
    if keep.len() < 2 { return Err("the regional run ends before the wave arrives; lengthen the offshore run".into()); }
    let edges = plan.edges.iter().map(|e| {
        let mut series = Vec::with_capacity(keep.len() * e.count);
        for s in &keep { for k in 0..e.count { series.push(scaled[s * points + e.first + k]); } }
        let edge_peak = series.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
        EdgeForcing { edge: e.edge, points: e.count, series, peak: edge_peak, snapped: e.snapped }
    }).collect();
    Ok(Forcing { times: keep.iter().map(|s| times[*s] - start).collect(), offset: start, arrival: times[arrival], peak, edges })
}

/// Boundary forcing from a user-supplied incoming-wave series (seconds from the start of the local run, metres): the same wave on every open edge, with no regional model or depth
/// scaling; the file's author owns the datum and the position.
pub fn forcing_from_series(open: &[Edge], times: &[f64], values: &[f64], max_local_seconds: f64, threshold: f64) -> Result<Forcing, String> {
    if times.len() != values.len() { return Err("the series times and values differ in length".into()); }
    let mut keep = Vec::new();
    for (s, t) in times.iter().enumerate() {
        keep.push(s);
        if *t > max_local_seconds { break; }
    }
    if keep.len() < 2 { return Err("the series needs at least two rows within the run".into()); }
    let peak = keep.iter().fold(0.0_f64, |m, s| m.max(values[*s].abs()));
    if peak <= 1e-4 { return Err("the series contains no wave larger than 0.1 mm".into()); }
    let arrival = keep.iter().find(|s| values[**s].abs() > threshold * peak).map_or(f64::NAN, |s| times[*s]);
    let edges = open.iter().map(|e| EdgeForcing { edge: *e, points: 1, series: keep.iter().map(|s| values[*s]).collect(), peak, snapped: 0 }).collect();
    Ok(Forcing { times: keep.iter().map(|s| times[*s]).collect(), offset: 0.0, arrival, peak, edges })
}

/// The sea edges of a local scene that have open water to drive, in solver order (north, east, south, west): `sea` are the edges the scene declares, `depth` its initial water depth.
pub fn open_edges(sea: &[Edge], w: usize, h: usize, depth: &[f64]) -> Result<Vec<Edge>, String> {
    if sea.is_empty() { return Err("this local scene declares no open sea edges to drive".into()); }
    let wet = |e: Edge| match e {
        Edge::North => (0..w).any(|x| depth[x] > 0.0),
        Edge::South => (0..w).any(|x| depth[(h - 1) * w + x] > 0.0),
        Edge::West => (0..h).any(|y| depth[y * w] > 0.0),
        Edge::East => (0..h).any(|y| depth[y * w + w - 1] > 0.0),
    };
    let open: Vec<Edge> = [Edge::North, Edge::East, Edge::South, Edge::West].into_iter().filter(|e| sea.contains(e) && wet(*e)).collect();
    if open.is_empty() { Err("no sea edge of this local scene has open water to drive".into()) } else { Ok(open) }
}

/// External sea level change at the open edges: a tide rising from the initial level as a sinusoid of the given period (default M2, 12.42 h), as (times, levels). Total level,
/// not a wave: the solver passes it through with no external current. None when there is no tide.
pub fn level_series(seconds: f64, amplitude: f64, period: f64, step: f64) -> Option<(Vec<f64>, Vec<f64>)> {
    if amplitude.is_nan() || amplitude <= 0.0 { return None; }
    let rows = ((seconds / step).ceil() as usize + 2).max(2);
    let times: Vec<f64> = (0..rows).map(|i| i as f64 * step).collect();
    let level = times.iter().map(|t| amplitude * (2.0 * std::f64::consts::PI * t / period).sin()).collect();
    Some((times, level))
}

/// Seconds the regional model should run. The 1.5 km grid sends waves into sheltered bays only slowly (hours), so allow generously: at least three hours, otherwise twice the
/// straight-line travel time at a mean speed, plus the lead and the local run.
pub fn parent_seconds(plan: &Plan, cell: f64, source: (f64, f64), local_seconds: f64, lead: f64, mean_speed: f64) -> f64 {
    let farthest = plan.points.iter().fold(0.0_f64, |m, p| m.max((p.0 - source.0 - 0.5).hypot(p.1 - source.1 - 0.5) * cell));
    (((2.0 * farthest / mean_speed + lead + local_seconds) / 60.0).ceil() * 60.0).clamp(10800.0, 21600.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nest::EdgeGroup;

    fn plan(count: usize) -> Plan {
        Plan { points: (0..count).map(|k| (10.5 + k as f64, 20.5)).collect(), gains: vec![1.0; count], flux_gains: Vec::new(), edges: vec![EdgeGroup { edge: Edge::East, first: 0, count, snapped: 0 }], handovers: Vec::new(), snapped: 0 }
    }
    // a Gaussian pulse at every point, arriving at 600 s, sampled every 60 s over 3 hours
    fn recording(count: usize, height: f64) -> Recording {
        let times: Vec<f64> = (0..180).map(|s| s as f64 * 60.0).collect();
        let values = times.iter().flat_map(|t| (0..count).map(move |_| height * (-((t - 600.0) / 120.0).powi(2)).exp())).collect();
        Recording { times, values, points: count }
    }

    #[test]
    fn the_local_clock_starts_a_little_before_the_wave_and_the_forcing_is_scaled_by_the_gains() {
        let mut p = plan(3);
        p.gains = vec![1.0, 2.0, 0.5];
        let f = forcing_from_recording(&p, &recording(3, 0.4), 120.0, 0.02, 3600.0).unwrap();
        assert!((f.peak - 0.8).abs() < 1e-9, "the largest scaled value: {}", f.peak);
        assert!(f.arrival > 300.0 && f.arrival < 600.0, "the wave passes 2% of its peak before its crest: {}", f.arrival);
        assert!(f.offset >= 0.0 && f.offset <= f.arrival && f.times[0] <= 0.0 && f.times[1] > 0.0 - 1e-9, "offset {} first times {:?}", f.offset, &f.times[..2]);
        assert!((f.arrival - f.offset - 120.0).abs() <= 60.0, "about the lead before it: arrival {} offset {}", f.arrival, f.offset);
        assert_eq!((f.edges.len(), f.edges[0].points, f.edges[0].series.len()), (1, 3, f.times.len() * 3));
        assert!((f.edges[0].peak - 0.8).abs() < 1e-9);
        assert!(*f.times.last().unwrap() >= 3600.0 && *f.times.last().unwrap() <= 3600.0 + 2.0 * 60.0 + 60.0);
    }

    #[test]
    fn a_wave_that_never_arrives_a_mismatched_recording_and_a_run_that_ends_first_are_refused() {
        let p = plan(2);
        assert!(forcing_from_recording(&p, &recording(2, 0.0), 120.0, 0.02, 3600.0).unwrap_err().contains("never reaches"));
        assert!(forcing_from_recording(&p, &Recording { times: vec![0.0, 1.0], values: vec![0.0; 2], points: 1 }, 120.0, 0.02, 3600.0).unwrap_err().contains("does not match"));
        let mut early = recording(2, 0.4);
        early.times.truncate(10); early.values.truncate(20);   // the pulse peaks at 600 s but the run stops at 540 s: only the rising edge is there
        let f = forcing_from_recording(&p, &early, 120.0, 0.02, 3600.0);
        assert!(f.is_ok() || f.unwrap_err().contains("ends before"));
    }

    #[test]
    fn a_series_drives_every_open_edge_and_is_cut_to_the_run() {
        let times: Vec<f64> = (0..31).map(|i| i as f64 * 20.0).collect();
        let values: Vec<f64> = times.iter().map(|t| 0.3 * (-((t - 200.0) / 80.0).powi(2)).exp()).collect();
        let f = forcing_from_series(&[Edge::North, Edge::East], &times, &values, 600.0, 0.02).unwrap();
        assert!((f.arrival - 80.0).abs() <= 40.0 && (f.peak - 0.3).abs() < 1e-9 && f.offset == 0.0);
        assert_eq!(f.edges.iter().map(|e| e.edge).collect::<Vec<_>>(), vec![Edge::North, Edge::East]);
        assert!(f.edges.iter().all(|e| e.points == 1 && e.series.len() == f.times.len()));
        let cut = forcing_from_series(&[Edge::East], &times, &values, 100.0, 0.02).unwrap();
        assert!(cut.times.len() == 7 && *cut.times.last().unwrap() == 120.0, "kept up to the first row past the run: {:?}", cut.times);
        assert!(forcing_from_series(&[Edge::East], &[0.0, 60.0], &[0.0, 0.0], 600.0, 0.02).unwrap_err().contains("no wave"));
        assert!(forcing_from_series(&[Edge::East], &[0.0], &[1.0], 600.0, 0.02).unwrap_err().contains("at least two"));
        assert!(forcing_from_series(&[Edge::East], &[0.0, 1.0], &[1.0], 600.0, 0.02).is_err());
    }

    #[test]
    fn only_declared_sea_edges_with_open_water_drive_the_model() {
        // 4 x 3 cells: the north and east columns are sea, the west edge is land
        let depth = [0.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0];
        assert_eq!(open_edges(&[Edge::East, Edge::North], 4, 3, &depth).unwrap(), vec![Edge::North, Edge::East]);
        assert_eq!(open_edges(&[Edge::North, Edge::West, Edge::South], 4, 3, &depth).unwrap(), vec![Edge::North], "a land edge or a dry one is skipped");
        assert!(open_edges(&[], 4, 3, &depth).unwrap_err().contains("no open sea edges"));
        assert!(open_edges(&[Edge::South, Edge::West], 4, 3, &depth).unwrap_err().contains("no sea edge"));
    }

    #[test]
    fn a_rising_tide_is_a_sinusoid_from_the_initial_level() {
        assert!(level_series(600.0, 0.0, 44712.0, 60.0).is_none());
        let (t, l) = level_series(600.0, 1.0, 4800.0, 60.0).unwrap();
        assert_eq!((t.len(), t[0], l[0]), (12, 0.0, 0.0));
        assert!((l[5] - (2.0 * std::f64::consts::PI * 300.0 / 4800.0).sin()).abs() < 1e-12);
        assert_eq!(level_series(1.0, 1.0, 44712.0, 60.0).unwrap().0.len(), 3);
    }

    #[test]
    fn the_regional_run_is_at_least_three_hours_and_at_most_six() {
        let p = plan(2);
        assert_eq!(parent_seconds(&p, 1500.0, (10.0, 20.0), 3600.0, 120.0, 120.0), 10800.0);
        let far = Plan { points: vec![(5000.0, 4000.0)], gains: vec![1.0], flux_gains: Vec::new(), edges: Vec::new(), handovers: Vec::new(), snapped: 0 };
        assert_eq!(parent_seconds(&far, 1500.0, (10.0, 20.0), 3600.0, 120.0, 120.0), 21600.0);
        let mid = Plan { points: vec![(400.0, 20.5)], gains: vec![1.0], flux_gains: Vec::new(), edges: Vec::new(), handovers: Vec::new(), snapped: 0 };
        let s = parent_seconds(&mid, 1500.0, (10.0, 20.0), 3600.0, 120.0, 120.0);
        assert!(s > 10800.0 && s < 21600.0 && s % 60.0 == 0.0, "{s}");
    }
}
