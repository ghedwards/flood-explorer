//! A dam failure on one of the map's dam models: the reservoir behind the wall is given a bed and a volume, a breach is opened through the wall following Froehlich's
//! equations, and the nonlinear shallow-water solver (`inundation`, wetting and drying) carries the water downstream. `plan` turns the area model into the solver's grid,
//! `Run` steps it and measures the discharge, and `Run::finish` puts the solver's extremes back on the area model's cells in the shape the impact tools take.
//!
//! What it assumes, in plain terms: the elevation model shows the reservoir as a flat surface with no bed, so the reservoir is given one level depth that holds the dam's
//! volume (capped by the wall's height); the wall is the ground between the reservoir's edge and the first cell 4 m or more below it; the breach is a straight cut through
//! that wall, as wide as Froehlich's mean breach width and opening over his failure time. The first-order scheme under-predicts run-up and smears fronts.

use crate::inundation::Solver;
use std::collections::{HashMap, VecDeque};

/// Seconds after the run starts that the breach begins to open, so the reservoir settles first.
pub const BREACH_START: f64 = 60.0;
/// Most cells a side of the solver window.
pub const MAX_SIDE: usize = 256;
/// Cells within this of the lake level (m), joined to the gauge, are the reservoir.
pub const LAKE_TOLERANCE: f64 = 0.3;
const DISCHARGE_WINDOW: f64 = 60.0;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode { Overtopping, Piping }

impl Mode {
    pub fn from_code(code: f64) -> Mode { if code == 1.0 { Mode::Piping } else { Mode::Overtopping } }
    fn k(self) -> f64 { if self == Mode::Piping { 1.0 } else { 1.4 } }
}

/// Froehlich's (1995) breach equations: mean breach width (m), time to fail (s) and peak outflow (m3/s), from the reservoir volume V (m3) and the depth of water above the
/// breach bottom h (m). K is 1.4 for overtopping and 1.0 for piping. The width and time are what the model uses; the peak is only compared with the solver's.
#[derive(Clone, Copy, Debug)]
pub struct Breach { pub width: f64, pub seconds: f64, pub peak: f64 }

pub fn froehlich(volume: f64, depth: f64, mode: Mode) -> Breach {
    Breach {
        width: 0.1803 * mode.k() * volume.powf(0.32) * depth.powf(0.19),
        seconds: 0.00254 * volume.powf(0.53) * depth.powf(-0.9) * 3600.0,
        peak: 0.607 * volume.powf(0.295) * depth.powf(1.24),
    }
}

/// An area model's terrain: `dem` and the `valid` and `ocean` masks of W x H cells of `cell` metres (row 0 the north edge).
pub struct Area { pub w: usize, pub h: usize, pub cell: f64, pub dem: Vec<f64>, pub valid: Vec<u8>, pub ocean: Vec<u8> }

impl Area {
    fn is_valid(&self, i: usize) -> bool { self.valid.is_empty() || self.valid[i] != 0 }
    fn is_ocean(&self, i: usize) -> bool { !self.ocean.is_empty() && self.ocean[i] != 0 }
}

/// What the dam is and how it fails. `route` is the cells from the gauge to `below` along the flow path (the wall is the part of it outside the reservoir) and
/// `downstream` the cells on from `below`, used to fit the window around the flood's way out.
pub struct Params {
    pub gauge: usize,
    pub crest: usize,
    pub below: usize,
    pub lake: f64,
    pub route: Vec<usize>,
    pub downstream: Vec<usize>,
    pub volume: f64,
    pub mode: Mode,
    pub time_scale: f64,
}

/// The reservoir: cells joined to the gauge whose ground is no higher than the lake level plus a tolerance, by flood fill on valid cells.
pub fn reservoir_cells(area: &Area, gauge: usize, level: f64, tolerance: f64, limit: usize) -> (Vec<u8>, usize) {
    let mut mask = vec![0u8; area.w * area.h];
    let mut stack = vec![gauge];
    let mut count = 0;
    mask[gauge] = 1;
    while let Some(i) = stack.pop() {
        if count >= limit { break; }
        count += 1;
        let (x, y) = ((i % area.w) as i64, (i / area.w) as i64);
        for (dx, dy) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= area.w as i64 || ny >= area.h as i64 { continue; }
            let j = ny as usize * area.w + nx as usize;
            if mask[j] != 0 || !area.is_valid(j) || area.dem[j].is_nan() || area.dem[j] > level + tolerance { continue; }
            mask[j] = 1;
            stack.push(j);
        }
    }
    (mask, count)
}

/// Everything the solver needs for a failure of the dam of an area model, on a window of at most MAX_SIDE cells a side (block-averaged when the terrain does not fit).
pub struct Plan {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub factor: usize,
    /// The window's top-left corner in the area model's cells.
    pub x0: usize,
    pub y0: usize,
    pub bed: Vec<f64>,
    pub reference: Vec<f64>,
    pub valid: Vec<u8>,
    pub lake: Vec<u8>,
    pub breach_cells: Vec<usize>,
    pub breach_to: Vec<f64>,
    pub breach_start: f64,
    pub breach_seconds: f64,
    pub depth: f64,
    pub wall_height: f64,
    /// Water the window actually holds (m3): the requested volume, less what the wall or the coarse grid cannot.
    pub volume: f64,
    pub requested: f64,
    pub froehlich: Breach,
    pub mode: Mode,
    pub reservoir_cells: usize,
    /// The run length (s): the breach's opening time plus an hour for the flood to pass, in whole 10-minute steps, 1 to 6 hours.
    pub seconds: f64,
}

pub fn plan(area: &Area, p: &Params) -> Result<Plan, String> {
    let (cell, lake) = (area.cell, p.lake);
    let n_area = area.w * area.h;
    if p.gauge >= n_area || p.below >= n_area || p.route.iter().chain(&p.downstream).any(|c| *c >= n_area) || p.volume.is_nan() || p.volume <= 0.0 || p.time_scale.is_nan() || p.time_scale <= 0.0 {
        return Err("invalid dam description".into());
    }
    let (lake_mask, count) = reservoir_cells(area, p.gauge, lake, LAKE_TOLERANCE, 400_000);
    if count < 4 { return Err("the reservoir is too small to show in this terrain model".into()); }
    let wall_height = (lake - area.dem[p.below]).max(1.0);
    let average = p.volume / (count as f64 * cell * cell);
    let depth = average.max(1.0).min(wall_height);
    let bed_lake = lake - depth;

    // the window: the reservoir and the way out, as few coarse cells as fit
    let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
    let mut include = |i: usize| { let (x, y) = (i % area.w, i / area.w); x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y); };
    for (i, m) in lake_mask.iter().enumerate() { if *m != 0 { include(i); } }
    include(p.below);
    let reach = (6000.0 / cell).round() as usize;
    for c in p.downstream.iter().take(reach) { include(*c); }
    let pad = (500.0 / cell).round() as usize;
    let (x0, y0) = (x0.saturating_sub(pad), y0.saturating_sub(pad));
    let (x1, y1) = ((x1 + pad).min(area.w - 1), (y1 + pad).min(area.h - 1));
    let factor = ((x1 - x0 + 1).max(y1 - y0 + 1) as f64 / MAX_SIDE as f64).ceil().max(1.0) as usize;
    // at least 64 coarse cells a side, centred, so there is room for the water to spread
    let side = |lo: usize, hi: usize, max: usize| -> (usize, usize) {
        let want = (((hi - lo + 1) as f64 / factor as f64).ceil() as usize).max(64.min(max / factor)) * factor;
        let slack = (want as i64 - (hi - lo + 1) as i64).div_euclid(2);
        let start = (lo as i64 - slack).min(max as i64 - want as i64).max(0) as usize;
        (start, want.min(max - start))
    };
    let ((sx, wx), (sy, wy)) = (side(x0, x1, area.w), side(y0, y1, area.h));
    let (w, h) = (wx / factor, wy / factor);
    if w < 4 || h < 4 { return Err("the terrain around the dam is too small for the dam-break model".into()); }

    let n = w * h;
    let (mut bed, mut reference, mut valid, mut lake_coarse, mut highest) = (vec![0.0; n], vec![0.0; n], vec![0u8; n], vec![0u8; n], vec![0.0; n]);
    for y in 0..h { for x in 0..w {
        let (mut z, mut ok, mut lake_n, mut top) = (0.0, 0usize, 0usize, f64::NEG_INFINITY);
        for yy in 0..factor { for xx in 0..factor {
            let i = (sy + y * factor + yy) * area.w + sx + x * factor + xx;
            if !area.is_valid(i) || !area.dem[i].is_finite() { continue; }
            ok += 1;
            top = top.max(area.dem[i]);
            if lake_mask[i] != 0 { z += area.dem[i].min(bed_lake); lake_n += 1; } else { z += area.dem[i]; }
        } }
        let j = y * w + x;
        if ok < factor * factor { continue; }   // a block with missing ground is a wall
        // a block that holds any of the reservoir is filled to the lake's level, so its surface matches its neighbours' and the water is at rest
        valid[j] = 1;
        bed[j] = z / ok as f64;
        reference[j] = if lake_n > 0 { (lake - bed[j]).max(0.0) } else { 0.0 };
        lake_coarse[j] = u8::from(lake_n * 2 >= ok);
        highest[j] = top;
    } }
    // Averaging a coarse block lowers a thin wall towards the ground beside it and lets the reservoir leak. Where the grid is coarser than the terrain, the blocks touching
    // the reservoir keep their highest ground, so the reservoir stays contained until the breach cuts it.
    if factor > 1 {
        let mut ring = Vec::new();
        for y in 0..h { for x in 0..w {
            let j = y * w + x;
            if valid[j] == 0 || lake_coarse[j] != 0 { continue; }
            let next = (-1i64..=1).any(|dy| (-1i64..=1).any(|dx| {
                let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                xx >= 0 && yy >= 0 && xx < w as i64 && yy < h as i64 && lake_coarse[yy as usize * w + xx as usize] != 0
            }));
            if next { ring.push(j); }
        } }
        for j in ring { bed[j] = bed[j].max(highest[j]); reference[j] = (lake - bed[j]).max(0.0); }
    }
    let coarse = |i: usize| -> Option<usize> {
        let (fx, fy) = ((i % area.w) as i64 - sx as i64, (i / area.w) as i64 - sy as i64);
        let (x, y) = (fx.div_euclid(factor as i64), fy.div_euclid(factor as i64));
        (x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h).then(|| y as usize * w + x as usize)
    };

    // the breach: the wall's cells on the route (outside the reservoir) and the cell below, widened across the flow to Froehlich's mean width
    let froehlich = froehlich(p.volume, depth, p.mode);
    let mut wall: Vec<usize> = p.route.iter().copied().filter(|i| lake_mask[*i] == 0).collect();
    // a wall is thinner than a coarse cell: keep the block that holds its crest as high as the crest (never averaged down towards the ground below it, which would let
    // the reservoir leak) and out of the reservoir, so the breach cuts through it
    for i in &wall {
        let Some(c) = coarse(*i) else { continue };
        if valid[c] == 0 || area.dem[*i].is_nan() || area.dem[*i] <= lake { continue; }
        bed[c] = bed[c].max(area.dem[*i]);
        reference[c] = 0.0;
        lake_coarse[c] = 0;
    }
    if !wall.contains(&p.below) { wall.push(p.below); }
    let ((fx, fy), (tx, ty)) = (((wall[0] % area.w) as f64, (wall[0] / area.w) as f64), ((p.below % area.w) as f64, (p.below / area.w) as f64));
    let (mut dx, mut dy) = (tx - fx, ty - fy);
    let len = dx.hypot(dy);
    let len = if len == 0.0 { 1.0 } else { len };
    dx /= len;
    dy /= len;
    let half = (froehlich.width / cell / 2.0).round().max(0.0) as i64;
    let invert = bed_lake.max(area.dem[p.below]);
    let mut chosen: Vec<(usize, f64)> = Vec::new();
    let mut index: HashMap<usize, usize> = HashMap::new();
    for i in &wall {
        let (x, y) = ((i % area.w) as f64, (i / area.w) as f64);
        for k in -half..=half {
            let (nx, ny) = ((x + (-dy * k as f64).round()) as i64, (y + (dx * k as f64).round()) as i64);
            if nx < 0 || ny < 0 || nx >= area.w as i64 || ny >= area.h as i64 { continue; }
            let fi = ny as usize * area.w + nx as usize;
            let Some(c) = coarse(fi) else { continue };
            if valid[c] == 0 || lake_coarse[c] != 0 { continue; }
            let to = area.dem[fi].min(invert);
            match index.get(&c) {
                Some(slot) => chosen[*slot].1 = chosen[*slot].1.min(to),
                None => { index.insert(c, chosen.len()); chosen.push((c, to)); }
            }
        }
    }
    let breach_cells: Vec<usize> = chosen.iter().map(|c| c.0).collect();
    // the cut starts level with the reservoir's surface (the water is at rest against it) and is lowered to its final level over Froehlich's failure time
    for c in &breach_cells { bed[*c] = lake; reference[*c] = 0.0; }
    let breach_to: Vec<f64> = chosen.iter().map(|(c, to)| to.min(bed[*c])).collect();

    let stored: f64 = reference.iter().sum::<f64>() * (cell * factor as f64).powi(2);
    let breach_seconds = froehlich.seconds * p.time_scale;
    let seconds = (((BREACH_START + breach_seconds + 3600.0) / 600.0).ceil() * 600.0).clamp(3600.0, 21600.0);
    Ok(Plan {
        w, h, cell: cell * factor as f64, factor, x0: sx, y0: sy, bed, reference, valid, lake: lake_coarse, breach_cells, breach_to,
        breach_start: BREACH_START, breach_seconds, depth, wall_height, volume: stored, requested: p.volume, froehlich, mode: p.mode, reservoir_cells: count, seconds,
    })
}

/// The run's extremes on the area model's cells, in the shape the impact tools take (as the 2D solver's expanded run).
pub struct AreaRun {
    pub depth: Vec<f32>,
    pub wet: Vec<u8>,
    pub level: Vec<f32>,
    /// Seconds after the breach began to open that the water first stood 10 cm up (NaN where it did not).
    pub arrival: Vec<f32>,
    pub class: Vec<u8>,
    pub speed: Vec<f32>,
    pub km2: [f64; 6],
    pub covered: usize,
    /// Water reached the edge of the solver's window, so the flood may go further than shown.
    pub edge: bool,
}

/// What a run saw at its worst on the solver's window, per cell.
pub struct Extremes<'a> { pub depth: &'a [f64], pub speed: &'a [f64], pub class: &'a [u8], pub arrival: &'a [f64] }

/// Put the solver's extremes on the area model's cells: the deepest water on ground the reservoir did not hold, its worst hazard class and speed, and the arrival time. The
/// reservoir itself is left dry.
pub fn run_on_area(area: &Area, plan: &Plan, e: &Extremes) -> AreaRun {
    let n = area.w * area.h;
    let (factor, w, h) = (plan.factor, plan.w, plan.h);
    let mut run = AreaRun { depth: vec![0.0; n], wet: vec![0; n], level: vec![f32::NAN; n], arrival: vec![f32::NAN; n], class: vec![0; n], speed: vec![0.0; n], km2: [0.0; 6], covered: 0, edge: false };
    for y in 0..h * factor { for x in 0..w * factor {
        let i = (plan.y0 + y) * area.w + plan.x0 + x;
        let c = (y / factor) * w + x / factor;
        if plan.valid[c] == 0 || plan.lake[c] != 0 || area.is_ocean(i) { continue; }
        run.covered += 1;
        let d = e.depth[c];
        if d.is_nan() || d < 0.01 { continue; }
        run.depth[i] = d as f32;
        run.wet[i] = 1;
        run.level[i] = (area.dem[i] + d) as f32;
        run.class[i] = e.class[c].max(1);
        run.speed[i] = e.speed[c] as f32;
        if e.arrival[c] >= 0.0 { run.arrival[i] = (e.arrival[c] - plan.breach_start).max(0.0) as f32; }
    } }
    let cell_km2 = area.cell * area.cell / 1e6;
    for c in &run.class { if *c > 0 { run.km2[*c as usize - 1] += cell_km2; } }
    let reached = |k: usize| e.depth[k] >= 0.1 && plan.lake[k] == 0;
    run.edge = (0..w).any(|k| reached(k) || reached((h - 1) * w + k)) || (0..h).any(|k| reached(k * w) || reached(k * w + w - 1));
    run
}

/// A planned failure being run: the solver, and the reservoir's discharge worked out as its fall in volume over the last minute or so.
pub struct Run {
    pub plan: Plan,
    pub area: Area,
    pub solver: Solver,
    lake_cells: Vec<usize>,
    history: VecDeque<(f64, f64)>,
    pub peak_discharge: f64,
    pub peak_discharge_at: f64,
}

impl Run {
    pub fn start(area: Area, params: &Params) -> Result<Run, String> {
        let plan = plan(&area, params)?;
        let n = plan.w * plan.h;
        let mut solver = Solver::new(plan.w, plan.h, plan.cell, plan.bed.clone(), plan.reference.clone(), vec![0.0; n], false, 0.035)?;
        solver.set_valid(plan.valid.clone())?;
        solver.set_breach(plan.breach_cells.clone(), plan.breach_to.clone(), plan.breach_start, plan.breach_seconds)?;
        solver.set_arrival_depth(0.1)?;
        let lake_cells: Vec<usize> = (0..n).filter(|i| plan.lake[*i] != 0).collect();
        let mut run = Run { plan, area, solver, lake_cells, history: VecDeque::new(), peak_discharge: 0.0, peak_discharge_at: 0.0 };
        run.history.push_back((0.0, run.held()));
        Ok(run)
    }

    fn held(&self) -> f64 { self.lake_cells.iter().map(|i| self.solver.water[*i]).sum::<f64>() * self.plan.cell * self.plan.cell }

    /// The reservoir's discharge now (m3/s): its fall in volume over about the last minute.
    pub fn discharge(&self) -> f64 {
        let (first, last) = (self.history.front().unwrap(), self.history.back().unwrap());
        let span = last.0 - first.0;
        if span > 0.0 { ((first.1 - last.1) / span).max(0.0) } else { 0.0 }
    }

    pub fn advance(&mut self, steps: usize) -> Result<(), String> {
        self.solver.advance(steps)?;
        let now = self.solver.time;
        self.history.push_back((now, self.held()));
        while self.history.len() > 2 && now - self.history[1].0 >= DISCHARGE_WINDOW { self.history.pop_front(); }
        let q = self.discharge();
        if q > self.peak_discharge { self.peak_discharge = q; self.peak_discharge_at = now; }
        Ok(())
    }

    pub fn finish(&self) -> AreaRun {
        let s = &self.solver;
        run_on_area(&self.area, &self.plan, &Extremes { depth: &s.peak_depth, speed: &s.peak_speed, class: &s.peak_class, arrival: &s.arrival })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A synthetic valley, `w` x 60 cells of 30 m: a flat reservoir (x 5 to 34, 20 cells wide) at 100 m, a wall across it (x 35 to 38, 103 m), and a floodplain below that
    // falls 0.1 m a cell with gentle banks.
    fn valley(w: usize) -> (Area, Params) {
        let h = 60;
        let mut dem = vec![0.0; w * h];
        for y in 0..h { for x in 0..w {
            let across = (y as f64 - 29.5).abs();
            dem[y * w + x] = if x <= 38 {
                if x < 35 { if x >= 5 && across < 10.0 { 100.0 } else { 100.0 + (across - 9.0).max(1.0) } } else if across < 12.0 { 103.0 } else { 105.0 + (across - 12.0) * 0.5 }
            } else { 94.0 - 0.1 * (x as f64 - 38.0) + 0.05 * across };
        } }
        let at = |x: usize, y: usize| y * w + x;
        let area = Area { w, h, cell: 30.0, dem, valid: vec![1; w * h], ocean: vec![0; w * h] };
        let params = Params {
            gauge: at(20, 30), crest: at(38, 30), below: at(39, 30), lake: 100.0, route: (20..=39).map(|x| at(x, 30)).collect(),
            downstream: (40..w - 1).map(|x| at(x, 30)).collect(), volume: 2e6, mode: Mode::Overtopping, time_scale: 1.0,
        };
        (area, params)
    }

    #[test]
    fn froehlich_gives_a_wider_breach_for_overtopping_than_piping_and_grows_with_the_volume() {
        let (over, pipe) = (froehlich(1e7, 15.0, Mode::Overtopping), froehlich(1e7, 15.0, Mode::Piping));
        assert!((over.width / pipe.width - 1.4).abs() < 1e-9);
        assert!(over.width > 30.0 && over.width < 400.0, "{}", over.width);
        assert!((over.seconds / 3600.0 - 1.14).abs() < 0.1, "a 10 million m3 dam 15 m deep fails in about an hour: {} h", over.seconds / 3600.0);
        assert!(froehlich(1e8, 15.0, Mode::Overtopping).peak > over.peak && froehlich(1e7, 25.0, Mode::Overtopping).peak > over.peak);
    }

    #[test]
    fn the_plan_gives_the_reservoir_a_bed_that_holds_the_volume_and_opens_a_breach_through_the_wall() {
        let (area, params) = valley(100);
        let p = plan(&area, &params).unwrap();
        assert!(p.w <= MAX_SIDE && p.h <= MAX_SIDE && p.w >= 64 && p.factor == 1);
        assert!((p.volume - 2e6).abs() / 2e6 < 0.02, "the reservoir holds the volume: {}", p.volume);
        assert!(p.depth > 3.0 && p.depth < p.wall_height && (p.wall_height - 6.1).abs() < 0.2);
        assert!(p.breach_cells.len() >= 3 && p.breach_cells.iter().zip(&p.breach_to).all(|(c, to)| p.valid[*c] != 0 && p.lake[*c] == 0 && *to <= p.bed[*c]));
        assert!(p.breach_to.iter().all(|z| *z >= 100.0 - p.depth - 1e-9 || *z >= 90.0), "never lowered below the reservoir bed or the ground below");
        assert_eq!(p.reservoir_cells, 30 * 20);
        // too big a volume is capped by the wall: the plan holds what the wall can
        let big = plan(&area, &Params { volume: 5e7, ..params_like(&params) }).unwrap();
        assert!(big.volume < 5e7 && (big.depth - big.wall_height).abs() < 1e-9);
        // the run's length: the breach's opening time plus an hour, in 10-minute steps, 1 to 6 hours
        assert!(p.seconds >= 3600.0 && p.seconds <= 21600.0 && p.seconds % 600.0 == 0.0);
        let quick = plan(&area, &Params { time_scale: 0.001, ..params_like(&params) }).unwrap();
        assert_eq!(quick.seconds, 4200.0);
        let slow = plan(&area, &Params { time_scale: 1000.0, ..params_like(&params) }).unwrap();
        assert_eq!(slow.seconds, 21600.0);
        let none = Area { valid: vec![0; area.w * area.h], ..area_like(&area) };
        assert!(plan(&none, &params).is_err());
        assert!(plan(&area, &Params { volume: -1.0, ..params_like(&params) }).is_err());
    }

    fn params_like(p: &Params) -> Params {
        Params { gauge: p.gauge, crest: p.crest, below: p.below, lake: p.lake, route: p.route.clone(), downstream: p.downstream.clone(), volume: p.volume, mode: p.mode, time_scale: p.time_scale }
    }
    fn area_like(a: &Area) -> Area { Area { w: a.w, h: a.h, cell: a.cell, dem: a.dem.clone(), valid: a.valid.clone(), ocean: a.ocean.clone() } }

    #[test]
    fn the_solver_carries_the_reservoir_through_the_breach_and_the_run_lands_on_the_area_model() {
        for (mode, peak_ratio) in [(Mode::Overtopping, 0.25..4.0), (Mode::Piping, 0.25..4.0)] {
            let (area, params) = valley(100);
            let mut run = Run::start(area_like(&area), &Params { mode, time_scale: 0.1, ..params_like(&params) }).unwrap();
            let seconds = 2400.0;
            while run.solver.time < seconds { run.advance(25).unwrap(); }
            assert!(run.solver.volume_error().abs() < 1e-3 * run.plan.volume, "{mode:?}: water conserved, error {}", run.solver.volume_error());
            let froehlich = run.plan.froehlich.peak;
            assert!(peak_ratio.contains(&(run.peak_discharge / froehlich)), "{mode:?}: solver peak {} against Froehlich {froehlich}", run.peak_discharge);
            assert!(run.peak_discharge_at > run.plan.breach_start);
            let out = run.finish();
            assert!(out.covered > 1000);
            assert_eq!(out.depth[params.gauge], 0.0, "the reservoir itself is not counted as flooded");
            let below = 30 * 100 + 50;
            assert!(out.depth[below] > 0.3 && out.wet[below] == 1 && out.class[below] >= 1 && out.arrival[below] > 0.0);
            assert!(out.km2.iter().sum::<f64>() > 0.05);
            assert!(out.arrival[30 * 100 + 60] > out.arrival[30 * 100 + 45], "arrival is measured from the start of the breach and grows downstream");
        }
    }

    #[test]
    fn on_a_coarser_window_the_thin_wall_still_holds_the_reservoir_until_the_breach_opens() {
        let (area, params) = valley(330);
        let mut run = Run::start(area, &Params { time_scale: 50.0, ..params }).unwrap();
        assert!(run.plan.factor >= 2 && run.plan.w <= MAX_SIDE && run.plan.h <= MAX_SIDE, "factor {}", run.plan.factor);
        let start = run.held();
        while run.solver.time < 55.0 { run.advance(25).unwrap(); }
        assert!((run.held() - start).abs() < 0.002 * start, "nothing leaves before the breach starts: {start} to {}", run.held());
    }
}
