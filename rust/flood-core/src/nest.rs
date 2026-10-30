//! Two-way nesting of a nonlinear local model (`inundation`) inside a linear regional model (`tsunami`), both stepped together.
//!
//! One-way nesting records the regional wave in advance and feeds it in at the local model's open sea edges; the local model never talks back, so the regional
//! model keeps reflecting off its own coarse coast. Here the two run in step and exchange both ways:
//!
//! * **Down.** Every regional step, the regional surface displacement is read at the handover points along the local open edges, scaled to the local depth by
//!   Green's law (eta ~ H^-1/4, bounded 0.5 to 2) and added to the local model's incoming-wave forcing as a new sample, together with the regional transport through the
//!   edge (scaled the same way, and by the square root of the depth ratio). Handing over the velocity as well is what lets the edge tell the regional wave that is arriving from
//!   the one that has already reflected from the regional model's own coast: with the surface alone, that reflection is taken for incoming and re-enters (`Forcing` in
//!   `inundation.rs`).
//! * **Up.** When the local model has caught up with the regional one, each regional cell the local grid covers is nudged towards the mean surface displacement of
//!   the local sea cells inside it (scaled back by the inverse of the same law), with a weight that is 0 within `margin` regional cells of an open edge and rises to
//!   1 over `ramp` more cells (by default the first 65% of the way in and the next 17%), so the regional wave entering the local model is left alone and the feedback
//!   acts near the coast, where the two models can differ. `strength` (0 to 1) is the share of the
//!   difference removed each regional step; 0 leaves the regional model exactly as it runs alone (the local model is still driven by it live).
//!
//! The up step is a relaxation, not an exact flux match; the volume it moves is kept in `feedback_volume`.
//!
//! **Three levels.** A nest is itself a `Coarse` model, so a nest whose local model is an intermediate grid (`nest_grid.rs`, about 250 m, nonlinear) can be the parent of the
//! real local model: regional -> intermediate -> local. The local scenes are 4 to 8 km across, a few regional cells, so on their own they cover too little of the regional
//! model to hand much back; the intermediate grid covers tens of regional cells and carries the local coast to them.
//!
//! Everything is plain arrays: `plan_aligned` for grids that sit on each other (tests), `plan_geographic` for the lab's MGA local grids inside a
//! longitude/latitude regional grid.

use crate::geo;
use crate::inundation::{Edge, Solver as Child};
use crate::tsunami::{taps_over, Solver as Regional, Tap};

const EDGES: [Edge; 4] = [Edge::North, Edge::East, Edge::South, Edge::West];
const WET_SEARCH: i64 = 8;

/// A model that hands its wave to a finer one and takes the finer model's answer back: the regional linear model, or a nonlinear intermediate grid (itself the
/// finer half of another nest).
pub trait Coarse {
    /// Width, height and cell size.
    fn dims(&self) -> (usize, usize, f64);
    /// Still-water depth of each cell, 0 on land.
    fn depth(&self) -> &[f64];
    /// Surface displacement of each cell now.
    fn surface(&self) -> &[f64];
    /// The model's own time, s.
    fn clock(&self) -> f64;
    /// One step of its own.
    fn step(&mut self) -> Result<(), String>;
    /// The depth-integrated transport of cell `i` (m2/s, x then y).
    fn transport(&self, i: usize) -> (f64, f64);
    /// Take the finer model's answer: each handover's cell moves a share `strength * weight` towards its local surface mean (`means[k].0`, already scaled to this model's depth)
    /// and its transport towards the transport means (`means[k].1`, `.2`). `slot` is the handover (if any) of each cell. Returns the volume added, m3.
    fn relax(&mut self, plan: &Plan, slot: &[Option<usize>], means: &[(f64, f64, f64)], strength: f64) -> f64;
}

impl Coarse for Regional {
    fn dims(&self) -> (usize, usize, f64) { (self.w, self.h, self.cell) }
    fn depth(&self) -> &[f64] { &self.depth }
    fn surface(&self) -> &[f64] { &self.eta }
    fn clock(&self) -> f64 { self.time }
    fn step(&mut self) -> Result<(), String> { self.advance(1) }
    fn transport(&self, i: usize) -> (f64, f64) { self.centre_transport(i) }
    fn relax(&mut self, plan: &Plan, slot: &[Option<usize>], means: &[(f64, f64, f64)], strength: f64) -> f64 {
        let (w, area, mut volume) = (self.w, self.cell * self.cell, 0.0);
        for (k, h) in plan.handovers.iter().enumerate() {
            // the transport through the face to the east and the face to the south, when the neighbour is handed over too
            let (x, y) = (h.parent % w, h.parent / w);
            if x + 1 < w { if let Some(n) = slot[h.parent + 1] {
                let g = &plan.handovers[n];
                self.nudge_flux_x(x + 1, y, 0.5 * (means[k].1 + means[n].1), strength * h.weight.min(g.weight));
            } }
            if y + 1 < self.h { if let Some(n) = slot[h.parent + w] {
                let g = &plan.handovers[n];
                self.nudge_flux_y(x, y + 1, 0.5 * (means[k].2 + means[n].2), strength * h.weight.min(g.weight));
            } }
            let delta = strength * h.weight * (means[k].0 - self.eta[h.parent]);
            self.eta[h.parent] += delta;
            self.peak[h.parent] = self.peak[h.parent].max(self.eta[h.parent].abs());
            volume += delta * area;
        }
        volume
    }
}

impl Coarse for Child {
    fn dims(&self) -> (usize, usize, f64) { (self.w, self.h, self.cell) }
    fn depth(&self) -> &[f64] { &self.reference }
    fn surface(&self) -> &[f64] { &self.eta }
    fn clock(&self) -> f64 { self.time }
    fn step(&mut self) -> Result<(), String> { self.advance(1) }
    fn transport(&self, i: usize) -> (f64, f64) { (self.momentum().0[i], self.momentum().1[i]) }
    fn relax(&mut self, plan: &Plan, _slot: &[Option<usize>], means: &[(f64, f64, f64)], strength: f64) -> f64 {
        let mut volume = 0.0;
        for (k, h) in plan.handovers.iter().enumerate() {
            let alpha = strength * h.weight;
            self.relax_momentum(h.parent, means[k].1, means[k].2, alpha);
            volume += self.relax_surface(h.parent, means[k].0, alpha);
        }
        volume
    }
}

/// One handover point being planned: where it reads the parent, and the scales for the surface and for the transport.
type Slot = ((f64, f64), f64, f64);

/// The handover points of one open edge, as a run of `count` entries in `Plan::points`.
pub struct EdgeGroup { pub edge: Edge, pub first: usize, pub count: usize, pub snapped: usize }

/// One regional cell the local model covers: the local sea cells inside it, how strongly it follows them and the scale between their surface and its own.
pub struct Handover { pub parent: usize, pub weight: f64, pub gain: f64, pub gain_flux: f64, pub children: Vec<usize> }

pub struct Plan {
    /// Regional fractional cell coordinates (centres at i + 0.5) of the handover points, edge by edge.
    pub points: Vec<(f64, f64)>,
    /// Green's-law scale from the regional wave at each point to the local edge.
    pub gains: Vec<f64>,
    /// The scale for the regional transport at each point (the surface scale times the square root of the depth ratio, as a transport is the surface times the wave speed);
    /// empty when the transports are not handed over.
    pub flux_gains: Vec<f64>,
    pub edges: Vec<EdgeGroup>,
    pub handovers: Vec<Handover>,
    /// Handover points moved to a nearby wet regional cell.
    pub snapped: usize,
}

fn green(from_depth: f64, to_depth: f64) -> f64 {
    if from_depth > 0.0 && to_depth > 0.0 { (from_depth / to_depth).powf(0.25).clamp(0.5, 2.0) } else { 1.0 }
}

// The nearest wet regional cell centre to a fractional point, within WET_SEARCH cells: (centre, distance in cells).
fn wet_near(parent: &dyn Coarse, x: f64, y: f64) -> Option<((f64, f64), f64)> {
    let (pw, ph, _) = parent.dims();
    let pdepth = parent.depth();
    let (cx, cy) = (x.floor() as i64, y.floor() as i64);
    let mut best: Option<((f64, f64), f64)> = None;
    for j in cy - WET_SEARCH..=cy + WET_SEARCH {
        for i in cx - WET_SEARCH..=cx + WET_SEARCH {
            if i < 0 || j < 0 || i >= pw as i64 || j >= ph as i64 || pdepth[j as usize * pw + i as usize] <= 0.0 { continue; }
            let d = ((i as f64 + 0.5 - x).powi(2) + (j as f64 + 0.5 - y).powi(2)).sqrt();
            if best.is_none_or(|b| d < b.1) { best = Some(((i as f64 + 0.5, j as f64 + 0.5), d)); }
        }
    }
    best.filter(|b| b.1 <= WET_SEARCH as f64)
}

/// Build the plan for any placement of the local grid in the regional one. `map` takes a local cell's centre (x + 0.5, y + 0.5) and returns the regional
/// fractional coordinates of that point. `open` are the local edges the regional wave enters by; `per_edge` the most handover points on each.
pub fn plan_with(parent: &dyn Coarse, child: &Child, open: &[Edge], per_edge: usize, margin: Option<f64>, ramp: Option<f64>, map: &dyn Fn(f64, f64) -> (f64, f64)) -> Result<Plan, String> {
    if open.is_empty() { return Err("the local scene declares no open sea edges to drive".into()); }
    if per_edge == 0 || margin.is_some_and(|m| m.is_nan() || m < 0.0) || ramp.is_some_and(|r| r.is_nan() || r <= 0.0) { return Err("invalid nesting settings".into()); }
    let (w, h) = (child.w, child.h);
    let (pw, ph, pcell) = parent.dims();
    let pdepth = parent.depth();
    let (mut points, mut gains, mut flux_gains, mut edges, mut snapped) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), 0usize);
    for edge in EDGES.into_iter().filter(|e| open.contains(e)) {
        let horizontal = matches!(edge, Edge::North | Edge::South);
        let length = if horizontal { w } else { h };
        let count = per_edge.min(length);
        let (first, mut wet, before) = (points.len(), 0usize, snapped);
        // a point for each place along the edge; where the local edge is dry there is nothing to drive, and it copies a neighbour (its value is only read by interpolation)
        let mut slots: Vec<Option<Slot>> = Vec::with_capacity(count);
        for k in 0..count {
            let along = (length - 1).min(((k as f64 + 0.5) / count as f64 * length as f64).floor() as usize);
            let (x, y) = match edge { Edge::North => (along, 0), Edge::South => (along, h - 1), Edge::West => (0, along), Edge::East => (w - 1, along) };
            let local_depth = child.reference[y * w + x];
            if local_depth <= 0.0 { slots.push(None); continue; }
            let (px, py) = map(x as f64 + 0.5, y as f64 + 0.5);
            if px < 0.5 || py < 0.5 || px > pw as f64 - 0.5 || py > ph as f64 - 0.5 {
                return Err(format!("the {edge:?} edge of the local scene lies outside the regional model"));
            }
            let (point, moved) = wet_near(parent, px, py).ok_or_else(|| format!("no regional ocean cell near the {edge:?} edge; it cannot be driven"))?;
            if moved > 1.0 { snapped += 1; }
            wet += 1;
            let regional = pdepth[(point.1.floor() as usize).min(ph - 1) * pw + (point.0.floor() as usize).min(pw - 1)];
            let gain = green(regional, local_depth);
            slots.push(Some((point, gain, if regional > 0.0 { (gain * (local_depth / regional).sqrt()).clamp(0.25, 4.0) } else { 1.0 })));
        }
        if wet > 0 {
            for k in 0..count {
                let (point, gain, flux) = slots[k].or_else(|| (1..count).find_map(|d| slots.get(k.wrapping_sub(d)).copied().flatten().or_else(|| slots.get(k + d).copied().flatten()))).unwrap();
                points.push(point); gains.push(if slots[k].is_some() { gain } else { 1.0 }); flux_gains.push(if slots[k].is_some() { flux } else { 1.0 });
            }
            edges.push(EdgeGroup { edge, first, count, snapped: snapped - before });
        }
    }
    if edges.is_empty() { return Err("no open sea edge of the local scene has open water to drive".into()); }

    // which regional cell each local cell falls in
    let ratio2 = (pcell / child.cell).powi(2);
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); pw * ph];
    let mut covered = vec![0usize; pw * ph];
    let mut centre = vec![(0.0, 0.0); pw * ph];
    for y in 0..h { for x in 0..w {
        let (px, py) = map(x as f64 + 0.5, y as f64 + 0.5);
        if px < 0.0 || py < 0.0 || px >= pw as f64 || py >= ph as f64 { continue; }
        let p = py.floor() as usize * pw + px.floor() as usize;
        covered[p] += 1;
        centre[p].0 += x as f64 + 0.5; centre[p].1 += y as f64 + 0.5;
        if child.reference[y * w + x] > 0.0 { members[p].push(y * w + x); }
    } }
    let mut found = Vec::new();   // (regional cell, distance from the nearest open edge in regional cells)
    for p in 0..pw * ph {
        // mostly inside the local grid, with sea in it, on regional ocean
        if pdepth[p] <= 0.0 || (covered[p] as f64) < 0.6 * ratio2 || (members[p].len() as f64) < 0.25 * covered[p] as f64 { continue; }
        let (cx, cy) = (centre[p].0 / covered[p] as f64, centre[p].1 / covered[p] as f64);
        let mut distance = f64::INFINITY;
        for e in open {
            let d = match e { Edge::West => cx, Edge::East => w as f64 - cx, Edge::North => cy, Edge::South => h as f64 - cy };
            distance = distance.min(d);
        }
        found.push((p, distance * child.cell / pcell));
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
        let gain = green(local_depth, pdepth[p]);
        // a transport scales as eta times the wave speed, so by Green's law it takes the inverse of the depth ratio's quarter power
        let gain_flux = (gain * (pdepth[p] / local_depth).sqrt()).clamp(0.25, 4.0);
        handovers.push(Handover { parent: p, weight, gain, gain_flux, children: std::mem::take(&mut members[p]) });
    }
    Ok(Plan { points, gains, flux_gains, edges, handovers, snapped })
}

/// A local grid whose top-left corner sits at regional fractional coordinates `origin`, with the same axes and `parent.cell / child.cell` local cells to a regional one.
pub fn plan_aligned(parent: &dyn Coarse, child: &Child, origin: (f64, f64), open: &[Edge], per_edge: usize, margin: Option<f64>, ramp: Option<f64>) -> Result<Plan, String> {
    let scale = child.cell / parent.dims().2;
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

pub fn plan_geographic(parent: &dyn Coarse, child: &Child, geo: &Geography, open: &[Edge], tuning: &Tuning) -> Result<Plan, String> {
    let [west, south, east, north] = geo.bounds;
    let extent = geo.extent;
    if !(east > west && north > south) || !(extent[2] > extent[0] && extent[3] > extent[1]) { return Err("invalid regional bounds or local extent".into()); }
    let (xmin, ymax, zone) = (extent[0], extent[3], geo.zone);
    let (pw, ph, _) = parent.dims();
    let to_parent = |x: f64, y: f64| {
        let (lat, lon) = geo::from_mga(xmin + x * child.cell, ymax - y * child.cell, zone);
        ((lon - west) / (east - west) * pw as f64, (north - lat) / (north - south) * ph as f64)
    };
    plan_with(parent, child, open, tuning.per_edge, tuning.margin, tuning.ramp, &to_parent)
}

/// The parent's transport into the local model at each handover point, scaled to the local depth: the component normal to the edge, positive into the model. Empty when
/// the plan has no transport scales.
fn edge_flows<P: Coarse>(parent: &P, taps: &[Tap], plan: &Plan) -> Vec<f64> {
    if plan.flux_gains.len() != plan.points.len() { return Vec::new(); }
    let mut out = vec![0.0; plan.points.len()];
    for g in &plan.edges {
        for k in g.first..g.first + g.count {
            let (u, v) = taps[k].iter().fold((0.0, 0.0), |a, (i, w)| { let (u, v) = parent.transport(*i); (a.0 + u * w, a.1 + v * w) });
            let inward = match g.edge { Edge::West => u, Edge::East => -u, Edge::North => v, Edge::South => -v };
            out[k] = inward * plan.flux_gains[k];
        }
    }
    out
}

pub struct Nest<P: Coarse> {
    pub parent: P,
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

impl<P: Coarse> Nest<P> {
    /// Pair the models. `parent` is stepped alone until the wave at a handover point first passes `threshold` metres (0 to start at once, giving up after `max_seconds`
    /// of the parent's time); the local clock starts there. The local model needs no forcing set: it is created here from the parent's wave.
    pub fn new(mut parent: P, mut child: Child, plan: Plan, strength: f64, threshold: f64, max_seconds: f64) -> Result<Self, String> {
        if !(0.0..=1.0).contains(&strength) { return Err("the nesting strength is between 0 and 1".into()); }
        let (pw, ph, _) = parent.dims();
        let taps = taps_over(pw, ph, parent.depth(), &plan.points)?;
        let read = |p: &P| -> Vec<f64> { taps.iter().zip(&plan.gains).map(|(tap, g)| tap.iter().map(|(i, w)| p.surface()[*i] * w).sum::<f64>() * g).collect() };
        let flows = |p: &P| edge_flows(p, &taps, &plan);
        if threshold > 0.0 {
            while read(&parent).iter().all(|v| v.abs() <= threshold) {
                if parent.clock() > max_seconds { return Err("the offshore wave never reaches the local model within the regional run".into()); }
                parent.step()?;
            }
        }
        let offset = parent.clock();
        let (first, first_flow) = (read(&parent), flows(&parent));
        parent.step()?;
        let (second, second_flow) = (read(&parent), flows(&parent));
        for g in &plan.edges {
            let range = g.first..g.first + g.count;
            let rows: Vec<f64> = first[range.clone()].iter().chain(&second[range.clone()]).copied().collect();
            let flow_rows: Vec<f64> = if first_flow.is_empty() { Vec::new() } else { first_flow[range.clone()].iter().chain(&second_flow[range]).copied().collect() };
            child.set_forcing_with_flow(g.edge, vec![0.0, parent.clock() - offset], rows, flow_rows, g.count)?;
        }
        let mut slot = vec![None; pw * ph];
        for (k, h) in plan.handovers.iter().enumerate() { slot[h.parent] = Some(k); }
        Ok(Self { parent, child, plan, taps, slot, offset, strength, feedback_volume: 0.0 })
    }

    /// The local model's time.
    pub fn time(&self) -> f64 { self.child.time }

    fn push(&mut self) -> Result<(), String> {
        let surface = self.parent.surface();
        let values: Vec<f64> = self.taps.iter().zip(&self.plan.gains).map(|(tap, g)| tap.iter().map(|(i, w)| surface[*i] * w).sum::<f64>() * g).collect();
        let flows = edge_flows(&self.parent, &self.taps, &self.plan);
        let time = self.parent.clock() - self.offset;
        for g in &self.plan.edges {
            let range = g.first..g.first + g.count;
            self.child.push_forcing_with_flow(g.edge, time, &values[range.clone()], if flows.is_empty() { &[] } else { &flows[range] })?;
        }
        Ok(())
    }

    // The parent's cells the local grid covers move towards the local surface, and their transports towards the local transports.
    fn feedback(&mut self) {
        if self.strength == 0.0 { return; }
        let (mx, my) = self.child.momentum();
        // each handover's local means, scaled to the parent's depth
        let means: Vec<(f64, f64, f64)> = self.plan.handovers.iter().map(|h| {
            let n = h.children.len() as f64;
            let (e, u, v) = h.children.iter().fold((0.0, 0.0, 0.0), |a, i| (a.0 + self.child.eta[*i], a.1 + mx[*i], a.2 + my[*i]));
            (e / n * h.gain, u / n * h.gain_flux, v / n * h.gain_flux)
        }).collect();
        self.feedback_volume += self.parent.relax(&self.plan, &self.slot, &means, self.strength);
    }

    /// Advance the local model by `steps` of its own steps; the parent follows one of its steps at a time, always ahead, and takes the local model's answer
    /// each time the local model reaches its time.
    pub fn advance(&mut self, steps: usize) -> Result<(), String> {
        for _ in 0..steps {
            if self.child.time >= self.parent.clock() - self.offset - 1e-9 {
                self.feedback();
                self.parent.step()?;
                self.push()?;
            }
            self.child.advance(1)?;
        }
        Ok(())
    }
}

/// A nest is itself a coarse model for a still finer one: its local model is the intermediate grid.
impl<P: Coarse> Coarse for Nest<P> {
    fn dims(&self) -> (usize, usize, f64) { self.child.dims() }
    fn depth(&self) -> &[f64] { &self.child.reference }
    fn surface(&self) -> &[f64] { &self.child.eta }
    fn clock(&self) -> f64 { self.child.time }
    fn step(&mut self) -> Result<(), String> { self.advance(1) }
    fn transport(&self, i: usize) -> (f64, f64) { (self.child.momentum().0[i], self.child.momentum().1[i]) }
    fn relax(&mut self, plan: &Plan, slot: &[Option<usize>], means: &[(f64, f64, f64)], strength: f64) -> f64 { self.child.relax(plan, slot, means, strength) }
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
    fn regional(cells: usize, cell: f64, coast: f64) -> Regional {
        let n = cells * ROWS;
        // the regional coast is where the cell centre passes the true coast: the regional wall can be up to a cell out
        let depth: Vec<f64> = (0..n).map(|i| { let x = ((i % cells) as f64 + 0.5) * cell; if x < coast { depth_at(x) } else { 0.0 } }).collect();
        let eta: Vec<f64> = (0..n).map(|i| { let x = ((i % cells) as f64 + 0.5) * cell; if depth[i] > 0.0 { 0.1 * (-((x - 10000.0) / 1500.0).powi(2) / 2.0).exp() } else { 0.0 } }).collect();
        Regional::new(cells, ROWS, cell, depth, eta, false).unwrap()
    }
    // the local model: the east part of the strip, the same shelf, the same wall, west edge open
    fn local(first_cell: usize, cells: usize, cell: f64, coast: f64) -> Child { strip(first_cell, cells, LOCAL_ROWS, cell, coast) }
    fn strip(first_cell: usize, cells: usize, rows: usize, cell: f64, coast: f64) -> Child {
        let n = cells * rows;
        let bed: Vec<f64> = (0..n).map(|i| { let x = (first_cell as f64 + (i % cells) as f64 + 0.5) * cell; if x < coast { -depth_at(x) } else { 60.0 } }).collect();
        let reference: Vec<f64> = bed.iter().map(|b| (-b).max(0.0)).collect();
        Child::new(cells, rows, cell, bed, reference, vec![0.0; n], false, 0.0).unwrap()
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

        let nest_with = |strength: f64| -> (Vec<f64>, Nest<Regional>) {
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

    #[test]
    fn an_intermediate_grid_between_the_regional_and_local_models_keeps_the_gain_and_the_books() {
        // the same strip as above, but the local grid is only the last four regional cells (2,560 m of coast), so it covers too little of the regional model to hand much back on its
        // own; a 160 m grid between the 640 m regional cells and the 80 m local ones starts at x = 20,480 m (regional cell 32), is 1,920 m across (centred on the two middle regional rows),
        // and carries the local coast to the regional model
        let (pc, mc, fc, coast) = (640.0, 160.0, 80.0, 40720.0);
        let (mid_first, mid_cells, mid_rows) = (128usize, 128usize, 12usize);   // in 160 m cells from x = 0, 1,920 m across
        let local_first = 480usize;                                          // x = 38,400 m in 80 m cells
        let local_cells = 32;
        let probe_regional = 31usize;
        let until = 3400.0;
        let truth = { let mut t = fine_truth(512, fc, coast); let mut v = Vec::new(); let mut next = 0.0; while t.time < until { t.advance(1).unwrap(); if t.time >= next { v.push(t.eta[16 * 512 + 250]); next += 60.0; } } v };
        let alone = { let mut p = regional(64, pc, coast); let mut v = Vec::new(); let mut next = 0.0; while p.time < until { p.advance(1).unwrap(); if p.time >= next { v.push(p.eta[2 * 64 + probe_regional]); next += 60.0; } } v };
        let chain = |strength: f64| {
            let parent = regional(64, pc, coast);
            let mid = strip(mid_first, mid_cells, mid_rows, mc, coast);
            let plan_up = plan_aligned(&parent, &mid, (32.0, 0.5), &[Edge::West], 8, None, None).unwrap();
            let inner = Nest::new(parent, mid, plan_up, strength, 0.0, 0.0).unwrap();
            let child = local(local_first, local_cells, fc, coast);
            let plan_down = plan_aligned(&inner, &child, (112.0, 2.0), &[Edge::West], 8, None, None).unwrap();
            let mut outer = Nest::new(inner, child, plan_down, strength, 0.0, 0.0).unwrap();
            let mut v = Vec::new();
            let mut next = 0.0;
            while outer.parent.parent.time < until { outer.advance(1).unwrap(); if outer.parent.parent.time >= next { v.push(outer.parent.parent.eta[2 * 64 + probe_regional]); next += 60.0; } }
            (v, outer)
        };
        let small = {
            let parent = regional(64, pc, coast);
            let child = local(local_first, local_cells, fc, coast);
            let plan = plan_aligned(&parent, &child, (60.0, 1.0), &[Edge::West], 8, None, None).unwrap();
            let mut nest = Nest::new(parent, child, plan, 0.25, 0.0, 0.0).unwrap();
            let (mut v, mut next) = (Vec::new(), 0.0);
            while nest.parent.time < until { nest.advance(1).unwrap(); if nest.parent.time >= next { v.push(nest.parent.eta[2 * 64 + probe_regional]); next += 60.0; } }
            v
        };
        let (zero, n0) = chain(0.0);
        let (three, n3) = chain(0.25);
        let err = |a: &[f64]| { let m = a.len().min(truth.len()); (0..m).map(|k| (a[k] - truth[k]).powi(2)).sum::<f64>().sqrt() };
        let norm = truth.iter().map(|v| v * v).sum::<f64>().sqrt();
        assert!(zero.iter().zip(&alone).all(|(a, b)| (a - b).abs() < 1e-12) && n0.feedback_volume == 0.0 && n0.parent.feedback_volume == 0.0, "no feedback leaves the regional model alone");
        let (e_alone, e_three) = (err(&alone), err(&three));
        let e_small = err(&small);
        assert!(e_alone > 0.4 * norm, "the regional coast really is wrong here: error {e_alone} of {norm}");
        assert!(e_three < 0.5 * e_alone, "three-level {e_three} against regional alone {e_alone} (signal {norm})");
        assert!(e_three < 0.6 * e_small, "three-level {e_three} against the small local grid straight in the regional one {e_small}");
        assert!(three.iter().all(|v| v.is_finite() && v.abs() < 0.2));
        assert!(n3.plan.handovers.len() >= 4 && n3.parent.plan.handovers.len() >= 4 && n3.feedback_volume.abs() > 0.0 && n3.parent.feedback_volume.abs() > 0.0);
        // each level still accounts for its water: what the local model was given and what it was handed back are in the books
        assert!(n3.child.volume_error().abs() < 1e-3 * n3.child.initial_volume, "local {}", n3.child.volume_error());
        assert!(n3.parent.child.volume_error().abs() < 1e-3 * n3.parent.child.initial_volume, "intermediate {}", n3.parent.child.volume_error());
    }
}
