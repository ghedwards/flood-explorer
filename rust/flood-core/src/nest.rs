//! Two-way nesting of a nonlinear local model (`inundation`) inside a linear regional model (`tsunami`), both stepped together.
//!
//! One-way nesting records the regional wave in advance and feeds it in at the local model's open sea edges; the local model never talks back, so the regional
//! model keeps reflecting off its own coarse coast. Here the two run in step and exchange both ways:
//!
//! * **Down.** Every regional step, the regional surface displacement is read at the handover points along the local open edges, scaled to the local depth by
//!   Green's law (eta ~ H^-1/4, bounded 0.5 to 2) and added to the local model's incoming-wave forcing as a new sample.
//! * **Up.** When the local model has caught up with the regional one, each regional cell the local grid covers is nudged towards the mean surface displacement of
//!   the local sea cells inside it (scaled back by the inverse of the same law), with a weight that is 0 within `margin` regional cells of an open edge and rises to
//!   1 over `ramp` more cells (by default the first 65% of the way in and the next 17%), so the regional wave entering the local model is left alone and the feedback
//!   acts near the coast, where the two models can differ. `strength` (0 to 1) is the share of the
//!   difference removed each regional step; 0 is exactly the one-way model.
//!
//! The up step changes the regional surface only (its transports are left alone), so it is a relaxation, not an exact flux match; the volume it moves is kept in
//! `feedback_volume`. Everything is plain arrays: `plan_aligned` for grids that sit on each other (tests), `plan_geographic` for the lab's MGA local grids inside a
//! longitude/latitude regional grid.

use crate::geo;
use crate::inundation::{Edge, Solver as Child};
use crate::tsunami::{Solver as Parent, Tap};

const EDGES: [Edge; 4] = [Edge::North, Edge::East, Edge::South, Edge::West];
const WET_SEARCH: i64 = 8;

/// The handover points of one open edge, as a run of `count` entries in `Plan::points`.
pub struct EdgeGroup { pub edge: Edge, pub first: usize, pub count: usize, pub snapped: usize }

/// One regional cell the local model covers: the local sea cells inside it, how strongly it follows them and the scale between their surface and its own.
pub struct Handover { pub parent: usize, pub weight: f64, pub gain: f64, pub gain_flux: f64, pub children: Vec<usize> }

pub struct Plan {
    /// Regional fractional cell coordinates (centres at i + 0.5) of the handover points, edge by edge.
    pub points: Vec<(f64, f64)>,
    /// Green's-law scale from the regional wave at each point to the local edge.
    pub gains: Vec<f64>,
    pub edges: Vec<EdgeGroup>,
    pub handovers: Vec<Handover>,
    /// Handover points moved to a nearby wet regional cell.
    pub snapped: usize,
}

fn green(from_depth: f64, to_depth: f64) -> f64 {
    if from_depth > 0.0 && to_depth > 0.0 { (from_depth / to_depth).powf(0.25).clamp(0.5, 2.0) } else { 1.0 }
}

// The nearest wet regional cell centre to a fractional point, within WET_SEARCH cells: (centre, distance in cells).
fn wet_near(parent: &Parent, x: f64, y: f64) -> Option<((f64, f64), f64)> {
    let (cx, cy) = (x.floor() as i64, y.floor() as i64);
    let mut best: Option<((f64, f64), f64)> = None;
    for j in cy - WET_SEARCH..=cy + WET_SEARCH {
        for i in cx - WET_SEARCH..=cx + WET_SEARCH {
            if i < 0 || j < 0 || i >= parent.w as i64 || j >= parent.h as i64 || parent.depth[j as usize * parent.w + i as usize] <= 0.0 { continue; }
            let d = ((i as f64 + 0.5 - x).powi(2) + (j as f64 + 0.5 - y).powi(2)).sqrt();
            if best.is_none_or(|b| d < b.1) { best = Some(((i as f64 + 0.5, j as f64 + 0.5), d)); }
        }
    }
    best.filter(|b| b.1 <= WET_SEARCH as f64)
}

/// Build the plan for any placement of the local grid in the regional one. `map` takes a local cell's centre (x + 0.5, y + 0.5) and returns the regional
/// fractional coordinates of that point. `open` are the local edges the regional wave enters by; `per_edge` the most handover points on each.
pub fn plan_with(parent: &Parent, child: &Child, open: &[Edge], per_edge: usize, margin: Option<f64>, ramp: Option<f64>, map: &dyn Fn(f64, f64) -> (f64, f64)) -> Result<Plan, String> {
    if open.is_empty() { return Err("the local scene declares no open sea edges to drive".into()); }
    if per_edge == 0 || margin.is_some_and(|m| m.is_nan() || m < 0.0) || ramp.is_some_and(|r| r.is_nan() || r <= 0.0) { return Err("invalid nesting settings".into()); }
    let (w, h) = (child.w, child.h);
    let (mut points, mut gains, mut edges, mut snapped) = (Vec::new(), Vec::new(), Vec::new(), 0usize);
    for edge in EDGES.into_iter().filter(|e| open.contains(e)) {
        let horizontal = matches!(edge, Edge::North | Edge::South);
        let length = if horizontal { w } else { h };
        let count = per_edge.min(length);
        let (first, mut wet, before) = (points.len(), 0usize, snapped);
        for k in 0..count {
            let along = (length - 1).min(((k as f64 + 0.5) / count as f64 * length as f64).floor() as usize);
            let (x, y) = match edge { Edge::North => (along, 0), Edge::South => (along, h - 1), Edge::West => (0, along), Edge::East => (w - 1, along) };
            let local_depth = child.reference[y * w + x];
            let (px, py) = map(x as f64 + 0.5, y as f64 + 0.5);
            if px < 0.5 || py < 0.5 || px > parent.w as f64 - 0.5 || py > parent.h as f64 - 0.5 {
                return Err(format!("the {edge:?} edge of the local scene lies outside the regional model"));
            }
            let (point, moved) = wet_near(parent, px, py).ok_or_else(|| format!("no regional ocean cell near the {edge:?} edge; it cannot be driven"))?;
            if moved > 1.0 { snapped += 1; }
            if local_depth > 0.0 { wet += 1; }
            let regional = parent.depth[(point.1.floor() as usize).min(parent.h - 1) * parent.w + (point.0.floor() as usize).min(parent.w - 1)];
            gains.push(if local_depth > 0.0 { green(regional, local_depth) } else { 1.0 });
            points.push(point);
        }
        if wet > 0 { edges.push(EdgeGroup { edge, first, count, snapped: snapped - before }); } else { points.truncate(first); gains.truncate(first); }
    }
    if edges.is_empty() { return Err("no open sea edge of the local scene has open water to drive".into()); }

    // which regional cell each local cell falls in
    let ratio2 = (parent.cell / child.cell).powi(2);
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); parent.w * parent.h];
    let mut covered = vec![0usize; parent.w * parent.h];
    let mut centre = vec![(0.0, 0.0); parent.w * parent.h];
    for y in 0..h { for x in 0..w {
        let (px, py) = map(x as f64 + 0.5, y as f64 + 0.5);
        if px < 0.0 || py < 0.0 || px >= parent.w as f64 || py >= parent.h as f64 { continue; }
        let p = py.floor() as usize * parent.w + px.floor() as usize;
        covered[p] += 1;
        centre[p].0 += x as f64 + 0.5; centre[p].1 += y as f64 + 0.5;
        if child.reference[y * w + x] > 0.0 { members[p].push(y * w + x); }
    } }
    let mut found = Vec::new();   // (regional cell, distance from the nearest open edge in regional cells)
    for p in 0..parent.w * parent.h {
        // mostly inside the local grid, with sea in it, on regional ocean
        if parent.depth[p] <= 0.0 || (covered[p] as f64) < 0.6 * ratio2 || (members[p].len() as f64) < 0.25 * covered[p] as f64 { continue; }
        let (cx, cy) = (centre[p].0 / covered[p] as f64, centre[p].1 / covered[p] as f64);
        let mut distance = f64::INFINITY;
        for e in open {
            let d = match e { Edge::West => cx, Edge::East => w as f64 - cx, Edge::North => cy, Edge::South => h as f64 - cy };
            distance = distance.min(d);
        }
        found.push((p, distance * child.cell / parent.cell));
    }
    // By default the feedback leaves the first 65% of the way in from the open edge to the regional model's own wave and rises to full over the next 17%: where the two models
    // can differ is at the coast, not where the wave is still arriving.
    let reach = found.iter().fold(0.0_f64, |m, f| m.max(f.1));
    let (margin, ramp) = (margin.unwrap_or(0.65 * reach), ramp.unwrap_or((0.17 * reach).max(1.0)));
    let mut handovers = Vec::new();
    for (p, distance) in found {
        let weight = ((distance - margin) / ramp).clamp(0.0, 1.0);
        if weight <= 0.0 { continue; }
        let local_depth = members[p].iter().map(|i| child.reference[*i]).sum::<f64>() / members[p].len() as f64;
        let gain = green(local_depth, parent.depth[p]);
        // a transport scales as eta times the wave speed, so by Green's law it takes the inverse of the depth ratio's quarter power
        let gain_flux = (gain * (parent.depth[p] / local_depth).sqrt()).clamp(0.25, 4.0);
        handovers.push(Handover { parent: p, weight, gain, gain_flux, children: std::mem::take(&mut members[p]) });
    }
    Ok(Plan { points, gains, edges, handovers, snapped })
}

/// A local grid whose top-left corner sits at regional fractional coordinates `origin`, with the same axes and `parent.cell / child.cell` local cells to a regional one.
pub fn plan_aligned(parent: &Parent, child: &Child, origin: (f64, f64), open: &[Edge], per_edge: usize, margin: Option<f64>, ramp: Option<f64>) -> Result<Plan, String> {
    let scale = child.cell / parent.cell;
    plan_with(parent, child, open, per_edge, margin, ramp, &|x, y| (origin.0 + x * scale, origin.1 + y * scale))
}

/// Where a local MGA grid sits in a regional grid evenly resampled over lon/lat bounds.
pub struct Geography {
    /// [west, south, east, north] of the regional grid, degrees.
    pub bounds: [f64; 4],
    /// [xmin, ymin, xmax, ymax] of the local grid in MGA metres (row 0 the north edge).
    pub extent: [f64; 4],
    pub zone: i32,
}

/// How many handover points per open edge, and where the feedback starts and ramps (regional cells; `None` takes them from the nest's reach).
pub struct Tuning { pub per_edge: usize, pub margin: Option<f64>, pub ramp: Option<f64> }

pub fn plan_geographic(parent: &Parent, child: &Child, geo: &Geography, open: &[Edge], tuning: &Tuning) -> Result<Plan, String> {
    let [west, south, east, north] = geo.bounds;
    let extent = geo.extent;
    if !(east > west && north > south) || !(extent[2] > extent[0] && extent[3] > extent[1]) { return Err("invalid regional bounds or local extent".into()); }
    let (xmin, ymax, zone) = (extent[0], extent[3], geo.zone);
    let to_parent = |x: f64, y: f64| {
        let (lat, lon) = geo::from_mga(xmin + x * child.cell, ymax - y * child.cell, zone);
        ((lon - west) / (east - west) * parent.w as f64, (north - lat) / (north - south) * parent.h as f64)
    };
    plan_with(parent, child, open, tuning.per_edge, tuning.margin, tuning.ramp, &to_parent)
}

pub struct Nest {
    pub parent: Parent,
    pub child: Child,
    pub plan: Plan,
    taps: Vec<Tap>,
    // the handover (if any) of each regional cell
    slot: Vec<Option<usize>>,
    /// Regional time at which the local clock reads zero.
    pub offset: f64,
    /// 0 is one-way; 1 removes the whole regional-local difference at every regional step.
    pub strength: f64,
    /// Water the feedback has added to (+) or taken from (-) the regional model, m3.
    pub feedback_volume: f64,
}

impl Nest {
    /// Pair the models. `parent` is stepped alone until the wave at a handover point first passes `threshold` metres (0 to start at once, giving up after `max_seconds`
    /// of regional time); the local clock starts there. The local model needs no forcing set: it is created here from the regional wave.
    pub fn new(mut parent: Parent, mut child: Child, plan: Plan, strength: f64, threshold: f64, max_seconds: f64) -> Result<Self, String> {
        if !(0.0..=1.0).contains(&strength) { return Err("the nesting strength is between 0 and 1".into()); }
        let taps = parent.make_taps(&plan.points)?;
        let scaled = |p: &Parent| -> Vec<f64> { p.sample(&taps).iter().zip(&plan.gains).map(|(v, g)| v * g).collect() };
        if threshold > 0.0 {
            while scaled(&parent).iter().all(|v| v.abs() <= threshold) {
                if parent.time > max_seconds { return Err("the offshore wave never reaches the local model within the regional run".into()); }
                parent.advance(1)?;
            }
        }
        let offset = parent.time;
        let first = scaled(&parent);
        parent.advance(1)?;
        let second = scaled(&parent);
        for g in &plan.edges {
            let rows: Vec<f64> = first[g.first..g.first + g.count].iter().chain(&second[g.first..g.first + g.count]).copied().collect();
            child.set_forcing(g.edge, vec![0.0, parent.time - offset], rows, g.count)?;
        }
        let mut slot = vec![None; parent.w * parent.h];
        for (k, h) in plan.handovers.iter().enumerate() { slot[h.parent] = Some(k); }
        Ok(Self { parent, child, plan, taps, slot, offset, strength, feedback_volume: 0.0 })
    }

    /// The local model's time.
    pub fn time(&self) -> f64 { self.child.time }

    fn push(&mut self) -> Result<(), String> {
        let values: Vec<f64> = self.parent.sample(&self.taps).iter().zip(&self.plan.gains).map(|(v, g)| v * g).collect();
        let time = self.parent.time - self.offset;
        for g in &self.plan.edges { self.child.push_forcing(g.edge, time, &values[g.first..g.first + g.count])?; }
        Ok(())
    }

    // The regional cells the local grid covers move towards the local surface, and the transports between them towards the local transports.
    fn feedback(&mut self) {
        if self.strength == 0.0 { return; }
        let area = self.parent.cell * self.parent.cell;
        let (mx, my) = self.child.momentum();
        // each handover's local means, scaled to the regional depth
        let means: Vec<(f64, f64, f64)> = self.plan.handovers.iter().map(|h| {
            let n = h.children.len() as f64;
            let (e, u, v) = h.children.iter().fold((0.0, 0.0, 0.0), |a, i| (a.0 + self.child.eta[*i], a.1 + mx[*i], a.2 + my[*i]));
            (e / n * h.gain, u / n * h.gain_flux, v / n * h.gain_flux)
        }).collect();
        let w = self.parent.w;
        for (k, h) in self.plan.handovers.iter().enumerate() {
            // the transport through the face to the east and the face to the south, when the neighbour is handed over too
            let (x, y) = (h.parent % w, h.parent / w);
            if x + 1 < w { if let Some(n) = self.slot[h.parent + 1] {
                let g = &self.plan.handovers[n];
                self.parent.nudge_flux_x(x + 1, y, 0.5 * (means[k].1 + means[n].1), self.strength * h.weight.min(g.weight));
            } }
            if y + 1 < self.parent.h { if let Some(n) = self.slot[h.parent + w] {
                let g = &self.plan.handovers[n];
                self.parent.nudge_flux_y(x, y + 1, 0.5 * (means[k].2 + means[n].2), self.strength * h.weight.min(g.weight));
            } }
            let delta = self.strength * h.weight * (means[k].0 - self.parent.eta[h.parent]);
            self.parent.eta[h.parent] += delta;
            self.parent.peak[h.parent] = self.parent.peak[h.parent].max(self.parent.eta[h.parent].abs());
            self.feedback_volume += delta * area;
        }
    }

    /// Advance the local model by `steps` of its own steps; the regional model follows one of its steps at a time, always ahead, and takes the local model's answer
    /// each time the local model reaches its time.
    pub fn advance(&mut self, steps: usize) -> Result<(), String> {
        for _ in 0..steps {
            if self.child.time >= self.parent.time - self.offset - 1e-9 {
                self.feedback();
                self.parent.advance(1)?;
                self.push()?;
            }
            self.child.advance(1)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A one-dimensional shelf strip (six rows): deep to the west, shoaling to a 12 m shelf, a wall at the coast. `x` is metres from the west edge.
    fn depth_at(x: f64) -> f64 { 100.0 - 88.0 * ((x - 20000.0) / 20000.0).clamp(0.0, 1.0) }
    const ROWS: usize = 4;
    const FINE_ROWS: usize = 32;    // the same strip at the local resolution
    const LOCAL_ROWS: usize = 16;   // the local grid covers the middle two regional rows

    // The reference: the whole strip at the local resolution, nonlinear solver, coast wall at `coast` metres.
    fn fine_truth(cells: usize, cell: f64, coast: f64) -> Child {
        let n = cells * FINE_ROWS;
        let bed: Vec<f64> = (0..n).map(|i| { let x = ((i % cells) as f64 + 0.5) * cell; if x < coast { -depth_at(x) } else { 60.0 } }).collect();
        let reference: Vec<f64> = bed.iter().map(|b| (-b).max(0.0)).collect();
        let eta: Vec<f64> = (0..n).map(|i| { let x = ((i % cells) as f64 + 0.5) * cell; if reference[i] > 0.0 { 0.1 * (-((x - 10000.0) / 1500.0).powi(2) / 2.0).exp() } else { 0.0 } }).collect();
        Child::new(cells, FINE_ROWS, cell, bed, reference, eta, false, 0.0).unwrap()
    }
    fn regional(cells: usize, cell: f64, coast: f64) -> Parent {
        let n = cells * ROWS;
        // the regional coast is where the cell centre passes the true coast: the regional wall can be up to a cell out
        let depth: Vec<f64> = (0..n).map(|i| { let x = ((i % cells) as f64 + 0.5) * cell; if x < coast { depth_at(x) } else { 0.0 } }).collect();
        let eta: Vec<f64> = (0..n).map(|i| { let x = ((i % cells) as f64 + 0.5) * cell; if depth[i] > 0.0 { 0.1 * (-((x - 10000.0) / 1500.0).powi(2) / 2.0).exp() } else { 0.0 } }).collect();
        Parent::new(cells, ROWS, cell, depth, eta, false).unwrap()
    }
    // the local model: the east part of the strip, the same shelf, the same wall, west edge open
    fn local(first_cell: usize, cells: usize, cell: f64, coast: f64) -> Child {
        let n = cells * LOCAL_ROWS;
        let bed: Vec<f64> = (0..n).map(|i| { let x = (first_cell as f64 + (i % cells) as f64 + 0.5) * cell; if x < coast { -depth_at(x) } else { 60.0 } }).collect();
        let reference: Vec<f64> = bed.iter().map(|b| (-b).max(0.0)).collect();
        Child::new(cells, LOCAL_ROWS, cell, bed, reference, vec![0.0; n], false, 0.0).unwrap()
    }
    #[test]
    fn two_way_nesting_brings_the_local_coast_back_to_the_regional_model() {
        // regional 640 m cells, 64 across (41 km); local 80 m cells over the last 24 regional cells; the true coast at 40,720 m is 240 m inside the regional wall at 40,960 m
        let (pc, fc, ratio, coast) = (640.0, 80.0, 8usize, 40720.0);
        let truth_cells = 512;
        let first_regional = 40usize;   // the local grid starts at regional cell 40 (x = 25,600 m)
        let local_cells = (64 - first_regional) * ratio;
        let probe_regional = 31usize;   // x = 20,000 m, well west of the local grid
        let until = 3400.0;

        // truth
        let mut t = fine_truth(truth_cells, fc, coast);
        let probe_fine = (20000.0 / fc) as usize;
        let mut truth = Vec::new();
        { let mut next = 0.0; while t.time < until { t.advance(1).unwrap(); if t.time >= next { truth.push(t.eta[16 * truth_cells + probe_fine]); next += 60.0; } } }

        // the regional model alone
        let mut p = regional(64, pc, coast);
        let mut alone = Vec::new();
        { let mut next = 0.0; while p.time < until { p.advance(1).unwrap(); if p.time >= next { alone.push(p.eta[2 * 64 + probe_regional]); next += 60.0; } } }

        let nest_with = |strength: f64| -> (Vec<f64>, Nest) {
            let parent = regional(64, pc, coast);
            let child = local(first_regional * ratio, local_cells, fc, coast);
            let plan = plan_aligned(&parent, &child, (first_regional as f64, 1.0), &[Edge::West], 8, None, None).unwrap();
            let mut nest = Nest::new(parent, child, plan, strength, 0.0, 0.0).unwrap();
            let mut out = Vec::new();
            let mut next = 0.0;
            while nest.parent.time < until { nest.advance(1).unwrap(); if nest.parent.time >= next { out.push(nest.parent.eta[2 * 64 + probe_regional]); next += 60.0; } }
            (out, nest)
        };
        let (one_way, n1) = nest_with(0.0);
        let (two_way, n2) = nest_with(0.25);
        let err = |a: &[f64]| { let m = a.len().min(truth.len()); (0..m).map(|k| (a[k] - truth[k]).powi(2)).sum::<f64>().sqrt() };
        let norm = truth.iter().map(|v| v * v).sum::<f64>().sqrt();
        // with no feedback the regional model is exactly what it is on its own, and nothing is moved
        assert!(one_way.iter().zip(&alone).all(|(a, b)| (a - b).abs() < 1e-12) && n1.feedback_volume == 0.0);
        // the regional wall is 240 m out from the true coast: alone, the reflected wave comes back at the wrong time. With the local coast fed back, it is closer to the truth
        let (e_alone, e_two) = (err(&alone), err(&two_way));
        assert!(e_alone > 0.4 * norm, "the regional coast really is wrong here: error {e_alone} of {norm}");
        assert!(e_two < 0.65 * e_alone, "two-way {e_two} against regional alone {e_alone} (signal {norm})");
        assert!(two_way.iter().all(|v| v.is_finite() && v.abs() < 0.2), "the regional wave stays bounded");
        assert!(n2.plan.handovers.len() >= 10 && n2.feedback_volume.abs() > 0.0);
        assert!(n2.child.volume_error().abs() < 1e-3 * n2.child.initial_volume, "the local model still conserves what it is given");
    }
}
