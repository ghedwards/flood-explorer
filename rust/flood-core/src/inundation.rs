//! Experimental nonlinear 2-D shallow-water equations with wetting/drying.
//! First-order Rusanov flux + Audusse et al. (2004) hydrostatic reconstruction.
//! Bed and initial water depth are separate: disconnected lakes keep their level.
//! Reflecting walls, optional relaxation sponge, semi-implicit Manning friction.
const G: f64 = 9.81;
const DRY: f64 = 1e-7;
/// A cell counts as wet, for the hazard class and the arrival of water, from this depth (m).
const WET_HAZARD: f64 = 0.01;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Edge { North, East, South, West }

impl Edge {
    pub fn from_code(code: usize) -> Option<Edge> {
        [Edge::North, Edge::East, Edge::South, Edge::West].get(code).copied()
    }
}

/// Incoming surface displacement (m) imposed along one outer edge as a
/// function of time, from a coarser parent model. `values` is row-major
/// [sample][point]; the points are evenly spread along the edge and the
/// value is interpolated linearly in both time and position.
struct Forcing {
    edge: Edge,
    times: Vec<f64>,
    values: Vec<f64>,
    points: usize,
}

impl Forcing {
    fn at(&self, along: f64, time: f64) -> f64 {
        let n = self.times.len();
        let k = self.times.partition_point(|t| *t <= time).clamp(1, n - 1);
        let f = ((time - self.times[k - 1]) / (self.times[k] - self.times[k - 1])).clamp(0.0, 1.0);
        let p = (along * self.points as f64 - 0.5).clamp(0.0, (self.points - 1) as f64);
        let (p0, pf) = (p.floor() as usize, p - p.floor());
        let p1 = (p0 + 1).min(self.points - 1);
        let v = |s: usize, q: usize| self.values[s * self.points + q];
        let at = |s: usize| v(s, p0) * (1.0 - pf) + v(s, p1) * pf;
        at(k - 1) * (1.0 - f) + at(k) * f
    }
}

/// What `Solver::flood_summary` reports.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FloodSummary { pub flooded_hectares: f64, pub max_land_depth: f64, pub flooded_now_hectares: f64 }

/// A breach: the bed of `cells` is lowered from its starting level to `to` between `start` and `start + duration` (seconds), linearly. The water
/// in each cell keeps its depth, so water held behind a wall that gives way starts to flow through the gap without any water being made or lost.
struct Breach {
    cells: Vec<usize>,
    from: Vec<f64>,
    to: Vec<f64>,
    start: f64,
    duration: f64,
}

pub struct Solver {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub bed: Vec<f64>,
    pub water: Vec<f64>,
    pub reference: Vec<f64>,
    pub eta: Vec<f64>,
    pub peak: Vec<f64>,
    pub speed: Vec<f64>,
    /// The deepest water each cell held (m), the worst flood hazard class it saw (0 dry, 1 to 6, from depth and speed), and the first time (s) the water
    /// stood `arrival_depth` above its starting level (-1 if it never did). Updated every step, so a short fast moment is not missed.
    pub peak_depth: Vec<f64>,
    pub peak_speed: Vec<f64>,
    pub peak_class: Vec<u8>,
    pub arrival: Vec<f64>,
    /// When (s) each cell held its deepest water.
    pub peak_time: Vec<f64>,
    pub arrival_depth: f64,
    probes: Vec<usize>,
    probe_threshold: f64,
    /// For each probe cell, the first time (s) the surface was more than the threshold from its starting level, up or down (-1 if never). Checked every step.
    pub probe_arrival: Vec<f64>,
    pub time: f64,
    pub dt: f64,
    pub boundary_volume: f64,
    pub initial_volume: f64,
    valid: Vec<bool>,
    mx: Vec<f64>,
    my: Vec<f64>,
    sponge: Vec<f64>,
    roughness: f64,
    forcing: Vec<Forcing>,
    breach: Option<Breach>,
    level: Option<(Vec<f64>, Vec<f64>)>,
    order: u8,
    /// Reused every step instead of allocating the change in (h, mx, my) of every cell.
    scratch: Vec<[f64; 3]>,
    /// Reconstructed face states of the second-order scheme, one buffer per direction.
    recon: [Vec<[f64; 8]>; 2],
}

impl Solver {
    #[allow(clippy::too_many_arguments)]
    pub fn new(w: usize, h: usize, cell: f64, bed: Vec<f64>, reference: Vec<f64>, eta: Vec<f64>, absorbing: bool, roughness: f64) -> Result<Self, String> {
        let n = w.checked_mul(h).ok_or("grid overflow")?;
        if !(4..=512).contains(&w) || !(4..=512).contains(&h) || !cell.is_finite() || cell < 0.05
            || bed.len() != n || reference.len() != n || eta.len() != n
            || !roughness.is_finite() || !(0.0..=0.2).contains(&roughness)
            || bed.iter().any(|v| !v.is_finite() || !(-12000.0..=9000.0).contains(v))
            || reference.iter().any(|v| !v.is_finite() || !(0.0..=12000.0).contains(v))
            || eta.iter().any(|v| !v.is_finite() || v.abs() > 100.0) {
            return Err("invalid inundation terrain, water levels or roughness".into());
        }
        let water: Vec<_> = reference.iter().zip(&eta).map(|(h, e)| h + e).collect();
        if water.iter().any(|v| *v < 0.0) || !water.iter().any(|v| *v > DRY) {
            return Err("initial wave must leave non-negative water depth and some wet cells".into());
        }
        let mut sponge = vec![0.0; n];
        if absorbing {
            let width = (w.min(h) / 8).clamp(2, 16) as f64;
            for y in 0..h { for x in 0..w {
                let distance = x.min(w - 1 - x).min(y.min(h - 1 - y)) as f64;
                // Only initially wet boundary cells exchange water; no inland lake drain.
                if reference[y * w + x] > DRY {
                    sponge[y * w + x] = (1.0 - distance / width).max(0.0).powi(2);
                }
            } }
        }
        let initial_volume = water.iter().sum::<f64>() * cell * cell;
        let water_start = water.clone();
        let mut s = Self { w, h, cell, bed, water, reference, peak: eta.iter().map(|e| e.abs()).collect(), eta,
            speed: vec![0.0; n], peak_depth: water_start, peak_speed: vec![0.0; n], peak_class: vec![0; n], arrival: vec![-1.0; n], peak_time: vec![0.0; n], arrival_depth: 0.1, probes: Vec::new(), probe_threshold: 0.0, probe_arrival: Vec::new(), time: 0.0, dt: 0.0, boundary_volume: 0.0, initial_volume,
            valid: vec![true; n], mx: vec![0.0; n], my: vec![0.0; n], sponge, roughness, forcing: Vec::new(), breach: None, level: None, order: 1, scratch: Vec::new(), recon: [Vec::new(), Vec::new()] };
        s.dt = s.stable_dt();
        Ok(s)
    }

    /// Initial depth-integrated transport (m2/s), e.g. for a wave already
    /// travelling. It must be zero on dry cells and on cells excluded by the mask.
    pub fn set_momentum(&mut self, mx: Vec<f64>, my: Vec<f64>) -> Result<(), String> {
        let n = self.water.len();
        if mx.len() != n || my.len() != n || self.time != 0.0
            || mx.iter().chain(&my).any(|v| !v.is_finite() || v.abs() > 1.0e5)
            || (0..n).any(|i| self.water[i] <= DRY && (mx[i] != 0.0 || my[i] != 0.0)) {
            return Err("invalid initial momentum; it must be finite, zero on dry cells and set before the run".into());
        }
        self.mx = mx; self.my = my;
        self.dt = self.stable_dt();
        Ok(())
    }

    pub fn set_valid(&mut self, mask: Vec<u8>) -> Result<(), String> {
        if mask.len() != self.water.len() || mask.iter().any(|v| *v > 1) || !mask.contains(&1)
            || mask.iter().enumerate().any(|(i, v)| *v == 0 && (self.water[i] != 0.0 || self.reference[i] != 0.0 || self.eta[i] != 0.0)) {
            return Err("invalid inundation mask; excluded cells must contain no water".into());
        }
        self.valid = mask.iter().map(|v| *v == 1).collect();
        Ok(())
    }

    /// Drive one outer edge with an incoming wave from a parent model.
    ///
    /// Initially wet, valid cells on the edge use a Flather-type radiation
    /// condition: outward normal velocity sqrt(g/H) (eta - 2 eta_in), where
    /// eta is the interior surface displacement and eta_in the imposed
    /// incoming wave. Outgoing waves leave with little reflection; with
    /// eta_in = 0 it is a wall at rest. Cells that are dry at the start stay
    /// walls. The relaxation sponge is switched off, since it would damp the
    /// forced signal. The series is held at its last value after it ends.
    pub fn set_forcing(&mut self, edge: Edge, times: Vec<f64>, values: Vec<f64>, points: usize) -> Result<(), String> {
        if times.len() < 2 || times.len() > 1_000_000 || points == 0 || points > 1024
            || values.len() != times.len().checked_mul(points).ok_or("forcing overflow")?
            || times.iter().any(|t| !t.is_finite()) || times.windows(2).any(|p| p[1] <= p[0])
            || values.iter().any(|v| !v.is_finite() || v.abs() > 20.0) {
            return Err("invalid boundary forcing series".into());
        }
        if self.forcing.iter().any(|f| f.edge == edge) { return Err("this edge already has forcing".into()); }
        if (0..self.edge_len(edge)).all(|k| !self.edge_wet(edge, k)) {
            return Err("the forced edge has no initially wet cells".into());
        }
        self.sponge.iter_mut().for_each(|v| *v = 0.0);
        self.forcing.push(Forcing { edge, times, values, points });
        Ok(())
    }

    /// Lower the bed of `cells` to the levels in `to` between `start` and `start + duration` seconds (a dam wall giving way). Set it before the run starts.
    pub fn set_breach(&mut self, cells: Vec<usize>, to: Vec<f64>, start: f64, duration: f64) -> Result<(), String> {
        let n = self.water.len();
        if self.time != 0.0 || cells.is_empty() || cells.len() != to.len() || cells.iter().any(|c| *c >= n || !self.valid[*c])
            || to.iter().any(|v| !v.is_finite() || !(-12000.0..=9000.0).contains(v))
            || !start.is_finite() || start < 0.0 || !duration.is_finite() || duration < 0.0 {
            return Err("invalid breach: cells must be valid cells of the grid, with finite levels and times".into());
        }
        let from = cells.iter().map(|c| self.bed[*c]).collect();
        self.breach = Some(Breach { cells, from, to, start, duration });
        Ok(())
    }

    /// What a run has flooded, over the ground that is dry at mean sea level (`land[i]` is 1 there): the area it has put water on so far (counting the tide's own cover, as the
    /// model does), the deepest water on it and the area under water now, with hectares from the cell size.
    pub fn flood_summary(&self, land: &[u8]) -> FloodSummary {
        let (mut ever, mut now, mut deepest) = (0usize, 0usize, 0.0_f64);
        for (i, dry) in land.iter().enumerate().take(self.water.len()) {
            if *dry == 0 { continue; }
            if self.peak_depth[i] > 0.01 { ever += 1; }
            if self.peak_depth[i] > deepest { deepest = self.peak_depth[i]; }
            if self.water[i] > 0.01 { now += 1; }
        }
        let ha = self.cell * self.cell / 10000.0;
        FloodSummary { flooded_hectares: ever as f64 * ha, max_land_depth: deepest, flooded_now_hectares: now as f64 * ha }
    }

    /// The depth-integrated transport of every cell (m2/s) in x and y.
    pub fn momentum(&self) -> (&[f64], &[f64]) { (&self.mx, &self.my) }

    /// Watch some cells (gauges): the first time the surface leaves its starting level by more than `threshold` metres, up or down, is kept in `probe_arrival`.
    pub fn set_probes(&mut self, cells: Vec<usize>, threshold: f64) -> Result<(), String> {
        if cells.iter().any(|c| *c >= self.water.len()) || threshold.is_nan() || threshold < 0.0 { return Err("invalid gauge cells or threshold".into()); }
        self.probe_arrival = vec![-1.0; cells.len()];
        self.probes = cells;
        self.probe_threshold = threshold;
        Ok(())
    }

    /// The fastest water speed any cell has seen (m/s).
    pub fn max_speed(&self) -> f64 { self.peak_speed.iter().fold(0.0_f64, |m, v| m.max(*v)) }

    /// How deep the water must stand above a cell's starting level to count as having arrived (m).
    pub fn set_arrival_depth(&mut self, depth: f64) -> Result<(), String> {
        if !depth.is_finite() || depth <= 0.0 || depth > 100.0 { return Err("the arrival depth must be above 0 and at most 100 m".into()); }
        self.arrival_depth = depth;
        Ok(())
    }

    fn apply_breach(&mut self, time: f64) {
        let Some(b) = &self.breach else { return };
        let f = if b.duration <= 0.0 { if time >= b.start { 1.0 } else { 0.0 } } else { ((time - b.start) / b.duration).clamp(0.0, 1.0) };
        for k in 0..b.cells.len() { self.bed[b.cells[k]] = b.from[k] + (b.to[k] - b.from[k]) * f; }
    }

    /// Add one more sample to an edge's forcing, at `time` (after its last) with one value per point: for a parent model that runs alongside this one and hands
    /// its wave over step by step instead of in advance.
    pub fn push_forcing(&mut self, edge: Edge, time: f64, values: &[f64]) -> Result<(), String> {
        let Some(f) = self.forcing.iter_mut().find(|f| f.edge == edge) else { return Err("this edge has no forcing to extend".into()) };
        if values.len() != f.points || !time.is_finite() || time <= *f.times.last().unwrap() || values.iter().any(|v| !v.is_finite() || v.abs() > 20.0) {
            return Err("invalid forcing sample".into());
        }
        f.times.push(time);
        f.values.extend_from_slice(values);
        Ok(())
    }

    /// External sea level change (m) at all forced edges, e.g. a tide. Unlike
    /// the incoming wave it is a total level with no external current, so a
    /// closed basin settles at this level rather than at twice it. It is the
    /// change from the initial sea level, interpolated in time and held
    /// beyond its ends.
    pub fn set_level(&mut self, times: Vec<f64>, values: Vec<f64>) -> Result<(), String> {
        if times.len() < 2 || times.len() > 1_000_000 || values.len() != times.len()
            || times.iter().any(|t| !t.is_finite()) || times.windows(2).any(|p| p[1] <= p[0])
            || values.iter().any(|v| !v.is_finite() || v.abs() > 20.0) {
            return Err("invalid sea level series".into());
        }
        self.level = Some((times, values));
        Ok(())
    }

    fn level_at(&self, time: f64) -> f64 {
        let Some((times, values)) = &self.level else { return 0.0 };
        let k = times.partition_point(|t| *t <= time).clamp(1, times.len() - 1);
        let f = ((time - times[k - 1]) / (times[k] - times[k - 1])).clamp(0.0, 1.0);
        values[k - 1] * (1.0 - f) + values[k] * f
    }

    /// Last time covered by any forcing series.
    pub fn forcing_end(&self) -> Option<f64> {
        self.forcing.iter().map(|f| *f.times.last().unwrap()).reduce(f64::min)
    }

    fn edge_len(&self, edge: Edge) -> usize { if matches!(edge, Edge::North | Edge::South) { self.w } else { self.h } }

    fn edge_cell(&self, edge: Edge, k: usize) -> usize {
        match edge {
            Edge::North => k,
            Edge::South => (self.h - 1) * self.w + k,
            Edge::West => k * self.w,
            Edge::East => k * self.w + self.w - 1,
        }
    }

    fn edge_wet(&self, edge: Edge, k: usize) -> bool {
        let i = self.edge_cell(edge, k);
        self.valid[i] && self.reference[i] > DRY
    }

    // Boundary flux along +axis for a forced edge cell, as (flux, outward
    // normal sign). None leaves the cell as a reflecting wall.
    fn forced_flux(&self, edge: Edge, k: usize, axis: usize, state: (&[f64], &[f64], &[f64]), time: f64) -> Option<[f64; 3]> {
        let f = self.forcing.iter().find(|f| f.edge == edge)?;
        if !self.edge_wet(edge, k) { return None; }
        let i = self.edge_cell(edge, k);
        let (water, mx, my) = state;
        let h = water[i];
        if h <= DRY { return None; }
        let sign = if matches!(edge, Edge::East | Edge::South) { 1.0 } else { -1.0 };
        let still = self.reference[i].max(h);
        let eta_in = f.at((k as f64 + 0.5) / self.edge_len(edge) as f64, time);
        let c = (G * still).sqrt();
        let outward = ((G / still).sqrt() * (h - self.reference[i] - self.level_at(time) - 2.0 * eta_in)).clamp(-2.0 * c, 2.0 * c);
        let u = sign * outward;
        let tangent = 3 - axis;
        let mut flux = [h * u, 0.0, 0.0];
        flux[axis] = h * u * u + 0.5 * G * h * h;
        // Tangential momentum leaves with outflow; inflow brings none.
        flux[tangent] = if outward > 0.0 { u * [0.0, mx[i], my[i]][tangent] / h } else { 0.0 };
        Some(flux)
    }

    fn stable_dt(&self) -> f64 {
        let mut maximum = 0.0_f64;
        for i in 0..self.water.len() {
            if self.water[i] > DRY {
                let velocity = (self.mx[i].abs() + self.my[i].abs()) / self.water[i];
                maximum = maximum.max(velocity + 2.0 * (G * self.water[i]).sqrt());
            }
        }
        // Sum of directional characteristic speeds; conservative 2-D positivity CFL.
        (if self.order == 2 { 0.3 } else { 0.4 }) * self.cell / maximum.max(1e-6)
    }

    fn state(&self, i: usize) -> [f64; 3] {
        [self.water[i], self.mx[i], self.my[i]]
    }

    // Flux oriented from left to right (or top to bottom). Pressure corrections
    // balance the bed source, including the shore of a resting lake.
    fn face(left: [f64; 3], right: [f64; 3], zl: f64, zr: f64, axis: usize) -> ([f64; 3], f64, f64) {
        let z = zl.max(zr);
        let reconstruct = |s: [f64; 3], bed: f64| {
            let h = (s[0] + bed - z).max(0.0);
            let ratio = if s[0] > DRY { h / s[0] } else { 0.0 };
            [h, s[1] * ratio, s[2] * ratio]
        };
        let a = reconstruct(left, zl);
        let b = reconstruct(right, zr);
        let physical = |s: [f64; 3]| {
            let u = if s[0] > DRY { s[axis] / s[0] } else { 0.0 };
            let mut f = [s[axis], s[1] * u, s[2] * u];
            f[axis] += 0.5 * G * s[0] * s[0];
            (f, u.abs() + (G * s[0]).sqrt())
        };
        let (fa, ca) = physical(a);
        let (fb, cb) = physical(b);
        let mut flux = [0.0; 3];
        for k in 0..3 { flux[k] = 0.5 * (fa[k] + fb[k] - ca.max(cb) * (b[k] - a[k])); }
        (flux, 0.5 * G * (left[0].powi(2) - a[0].powi(2)), 0.5 * G * (right[0].powi(2) - b[0].powi(2)))
    }

    pub fn volume(&self) -> f64 { self.water.iter().sum::<f64>() * self.cell * self.cell }
    pub fn volume_error(&self) -> f64 { self.volume() - self.initial_volume - self.boundary_volume }

    pub fn advance(&mut self, steps: usize) -> Result<(), String> {
        if steps > 200 { return Err("advance at most 200 inundation steps per call".into()); }
        for _ in 0..steps { self.step()?; }
        Ok(())
    }

    /// Choose the scheme: 1 is first-order (Rusanov with hydrostatic
    /// reconstruction, forward Euler); 2 adds limited linear reconstruction in
    /// the interior of wet regions and a two-stage Heun step. Both keep rest
    /// states exact and mass conservative; shorelines stay first-order.
    pub fn set_order(&mut self, order: u8) -> Result<(), String> {
        if order != 1 && order != 2 { return Err("numerical order must be 1 or 2".into()); }
        if self.time != 0.0 { return Err("choose the numerical order before the run starts".into()); }
        self.order = order;
        self.dt = self.stable_dt();
        Ok(())
    }

    fn first_order_delta(&mut self, dt: f64) -> Vec<[f64; 3]> {
        let ratio = dt / self.cell;
        let mut delta = std::mem::take(&mut self.scratch);
        delta.clear();
        delta.resize(self.water.len(), [0.0; 3]);
        // Include mirrored ghost states at outer walls. Each interior face is
        // evaluated once, so its mass exchange is exactly equal and opposite.
        let mut inflow = 0.0;
        for axis in [1, 2] {
            let (across, along) = if axis == 1 { (self.w, self.h) } else { (self.h, self.w) };
            let mut visit = |row: usize, face: usize| {
                let index = |col: usize| if axis == 1 { row * self.w + col } else { col * self.w + row };
                let li = index(face.saturating_sub(1));
                let ri = index(face.min(across - 1));
                if !self.valid[li] && !self.valid[ri] { return; }
                // Two cells with no water at all exchange nothing (the flux is exactly zero).
                if self.water[li] == 0.0 && self.water[ri] == 0.0 { return; }
                let (mut zl, mut zr) = (self.bed[li], self.bed[ri]);
                let mut left = self.state(li);
                let mut right = self.state(ri);
                if face == 0 || !self.valid[li] { left = right; left[axis] = -right[axis]; zl = zr; }
                if face == across || !self.valid[ri] { right = left; right[axis] = -left[axis]; zr = zl; }
                let boundary = if face == 0 || face == across {
                    let edge = match (axis, face == 0) {
                        (1, true) => Edge::West, (1, false) => Edge::East,
                        (_, true) => Edge::North, (_, false) => Edge::South,
                    };
                    self.forced_flux(edge, row, axis, (&self.water, &self.mx, &self.my), self.time).map(|f| (f, edge))
                } else { None };
                let (flux, cl, cr) = if let Some((f, edge)) = boundary {
                    // Mass entering the domain, in m3, through this face.
                    inflow += if matches!(edge, Edge::West | Edge::North) { f[0] } else { -f[0] } * dt * self.cell;
                    (f, 0.0, 0.0)
                } else {
                    Self::face(left, right, zl, zr, axis)
                };
                for k in 0..3 {
                    if face > 0 && self.valid[li] { delta[li][k] -= ratio * (flux[k] + if k == axis { cl } else { 0.0 }); }
                    if face < across && self.valid[ri] { delta[ri][k] += ratio * (flux[k] + if k == axis { cr } else { 0.0 }); }
                }
            };
            for row in 0..along { for face in 0..=across { visit(row, face); } }
        }
        self.boundary_volume += inflow;
        delta
    }

    // Limited, interior-only reconstruction along `axis` (0 = x, 1 = y). For
    // each cell: [h_in, h_out, u_in, u_out, v_in, v_out, z_in, z_out], the values
    // at the faces towards lower and higher index. A cell reconstructs only if
    // it and both neighbours are valid and wet, and its depth comfortably
    // exceeds the bed and surface variation; otherwise it keeps its mean values,
    // which is exactly the first-order scheme there.
    fn reconstruct(&self, axis: usize, h: &[f64], vel: &[(f64, f64)], out_buf: &mut Vec<[f64; 8]>) {
        const WET: f64 = 0.01;
        let (w, rows) = (self.w, self.h);
        let step = if axis == 0 { 1 } else { w };
        let minmod = |a: f64, b: f64, c: f64| if a > 0.0 && b > 0.0 && c > 0.0 { a.min(b).min(c) } else if a < 0.0 && b < 0.0 && c < 0.0 { a.max(b).max(c) } else { 0.0 };
        let limited = |lo: f64, mid: f64, hi: f64| minmod(1.5 * (mid - lo), 0.5 * (hi - lo), 1.5 * (hi - mid));
        out_buf.clear();
        out_buf.extend((0..w * rows).map(|i| {
            let (x, y) = (i % w, i / w);
            let (u, v) = vel[i];
            let out = [h[i], h[i], u, u, v, v, self.bed[i], self.bed[i]];
            // a cell that is not wet enough keeps its mean values
            if h[i] < WET { return out; }
            let inside = if axis == 0 { x > 0 && x + 1 < w } else { y > 0 && y + 1 < rows };
            if !inside { return out; }
            let (a, b) = (i - step, i + step);
            if !(self.valid[i] && self.valid[a] && self.valid[b]) || h[a] < WET || h[b] < WET { return out; }
            let surface = |j: usize| h[j] + self.bed[j];
            let s_eta = limited(surface(a), surface(i), surface(b));
            let s_z = 0.5 * (self.bed[b] - self.bed[a]);
            let s_h = s_eta - s_z;
            // Keep both face depths positive with margin; otherwise stay first-order.
            if s_h.abs() > 1.8 * h[i] || s_z.abs() > 1.8 * h[i] { return out; }
            let (ua, ub) = (vel[a], vel[b]);
            let s_u = limited(ua.0, u, ub.0);
            let s_v = limited(ua.1, v, ub.1);
            [h[i] - 0.5 * s_h, h[i] + 0.5 * s_h, u - 0.5 * s_u, u + 0.5 * s_u, v - 0.5 * s_v, v + 0.5 * s_v, self.bed[i] - 0.5 * s_z, self.bed[i] + 0.5 * s_z]
        }));
    }

    // Time derivative of (h, mx, my) for the second-order scheme, and the water
    // entering through forced edges (m3/s). Same face fluxes and pressure
    // corrections as the first-order scheme, applied to reconstructed face
    // states, plus a centred bed-slope source from the reconstructed bed.
    fn rate(&self, h: &[f64], mx: &[f64], my: &[f64], time: f64, recon: &mut [Vec<[f64; 8]>; 2]) -> (Vec<[f64; 3]>, f64) {
        let n = h.len();
        let inv = 1.0 / self.cell;
        // velocities once for both directions (a dry cell has none)
        let vel: Vec<(f64, f64)> = (0..n).map(|i| if h[i] > DRY { (mx[i] / h[i], my[i] / h[i]) } else { (0.0, 0.0) }).collect();
        self.reconstruct(0, h, &vel, &mut recon[0]);
        self.reconstruct(1, h, &vel, &mut recon[1]);
        let mut rate = vec![[0.0; 3]; n];
        let mut inflow = 0.0;
        for axis in [1usize, 2] {
            let (across, along) = if axis == 1 { (self.w, self.h) } else { (self.h, self.w) };
            let r = &recon[axis - 1];
            for row in 0..along { for face in 0..=across {
                let index = |col: usize| if axis == 1 { row * self.w + col } else { col * self.w + row };
                let li = index(face.saturating_sub(1));
                let ri = index(face.min(across - 1));
                if !self.valid[li] && !self.valid[ri] { continue; }
                // Two cells with no water at all exchange nothing (the flux is exactly zero).
                if h[li] == 0.0 && h[ri] == 0.0 { continue; }
                // Left state: the lower cell's outward face; right: the upper cell's inward face.
                let pick = |c: &[f64; 8], outward: bool| {
                    let o = usize::from(outward);
                    ([c[o], c[o] * c[2 + o], c[o] * c[4 + o]], c[6 + o])
                };
                let (mut left, mut zl) = pick(&r[li], true);
                let (mut right, mut zr) = pick(&r[ri], false);
                if face == 0 || !self.valid[li] { left = right; left[axis] = -right[axis]; zl = zr; }
                if face == across || !self.valid[ri] { right = left; right[axis] = -left[axis]; zr = zl; }
                let boundary = if face == 0 || face == across {
                    let edge = match (axis, face == 0) {
                        (1, true) => Edge::West, (1, false) => Edge::East,
                        (_, true) => Edge::North, (_, false) => Edge::South,
                    };
                    self.forced_flux(edge, row, axis, (h, mx, my), time).map(|f| (f, edge))
                } else { None };
                let (flux, cl, cr) = if let Some((f, edge)) = boundary {
                    inflow += if matches!(edge, Edge::West | Edge::North) { f[0] } else { -f[0] } * self.cell;
                    (f, 0.0, 0.0)
                } else {
                    Self::face(left, right, zl, zr, axis)
                };
                for k in 0..3 {
                    if face > 0 && self.valid[li] { rate[li][k] -= inv * (flux[k] + if k == axis { cl } else { 0.0 }); }
                    if face < across && self.valid[ri] { rate[ri][k] += inv * (flux[k] + if k == axis { cr } else { 0.0 }); }
                }
            } }
        }
        // Centred bed-slope source from the reconstructed bed: -g h dz/dx.
        for i in 0..n {
            if !self.valid[i] || h[i] <= DRY { continue; }
            for axis in 0..2 {
                let c = &recon[axis][i];
                rate[i][1 + axis] -= G * h[i] * (c[7] - c[6]) * inv;
            }
        }
        (rate, inflow)
    }

    fn second_order_delta(&mut self, dt: f64) -> Result<Vec<[f64; 3]>, String> {
        let n = self.water.len();
        let mut recon = std::mem::take(&mut self.recon);
        let (r0, in0) = self.rate(&self.water, &self.mx, &self.my, self.time, &mut recon);
        let (mut h1, mut m1, mut n1) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        for i in 0..n {
            let h = self.water[i] + dt * r0[i][0];
            if !h.is_finite() || h < -1e-9 { return Err("inundation solver lost positivity; reset the scene".into()); }
            h1[i] = h.max(0.0);
            if h1[i] > DRY { m1[i] = self.mx[i] + dt * r0[i][1]; n1[i] = self.my[i] + dt * r0[i][2]; }
        }
        let (r1, in1) = self.rate(&h1, &m1, &n1, self.time + dt, &mut recon);
        self.recon = recon;
        self.boundary_volume += 0.5 * dt * (in0 + in1);
        Ok((0..n).map(|i| [0, 1, 2].map(|k| 0.5 * dt * (r0[i][k] + r1[i][k]))).collect())
    }

    fn step(&mut self) -> Result<(), String> {
        self.apply_breach(self.time);
        let dt = self.stable_dt();
        let delta = if self.order == 2 { self.second_order_delta(dt)? } else { self.first_order_delta(dt) };
        // The per-cell update works on plain slices of equal length, so no index is checked.
        let n = self.water.len();
        let (water, mx, my, eta, peak, speed) = (&mut self.water[..n], &mut self.mx[..n], &mut self.my[..n], &mut self.eta[..n], &mut self.peak[..n], &mut self.speed[..n]);
        let (reference, sponge, change) = (&self.reference[..n], &self.sponge[..n], &delta[..n]);
        let (peak_depth, peak_speed, peak_class, arrival, peak_time) = (&mut self.peak_depth[..n], &mut self.peak_speed[..n], &mut self.peak_class[..n], &mut self.arrival[..n], &mut self.peak_time[..n]);
        let (arrival_depth, t_end) = (self.arrival_depth, self.time + dt);
        let (roughness, cell) = (self.roughness, self.cell);
        let mut sponge_exchange = 0.0;
        for i in 0..n {
            let d = change[i];
            let h = water[i] + d[0];
            if !h.is_finite() || h < -1e-9 { return Err("inundation solver lost positivity; reset the scene".into()); }
            water[i] = h.max(0.0);
            mx[i] += d[1]; my[i] += d[2];
            if water[i] <= DRY { mx[i] = 0.0; my[i] = 0.0; }
            else if roughness != 0.0 {
                // (With no roughness the friction factor is exactly 1, so it is skipped.)
                let speed = (mx[i] * mx[i] + my[i] * my[i]).sqrt() / water[i];
                let friction = 1.0 + dt * G * roughness.powi(2) * speed / water[i].powf(4.0 / 3.0);
                mx[i] /= friction; my[i] /= friction;
            }
            if sponge[i] > 0.0 {
                let damping = (-sponge[i] * dt / 20.0).exp();
                let previous = water[i];
                water[i] = reference[i] + (previous - reference[i]) * damping;
                sponge_exchange += (water[i] - previous) * cell * cell;
                mx[i] *= damping; my[i] *= damping;
            }
            eta[i] = water[i] - reference[i];
            peak[i] = peak[i].max(eta[i].abs());
            speed[i] = if water[i] > DRY { (mx[i] * mx[i] + my[i] * my[i]).sqrt() / water[i] } else { 0.0 };
            if !speed[i].is_finite() { return Err("non-finite inundation velocity".into()); }
            if water[i] > peak_depth[i] { peak_depth[i] = water[i]; peak_time[i] = t_end; }
            if water[i] >= WET_HAZARD {
                if speed[i] > peak_speed[i] { peak_speed[i] = speed[i]; }
                let class = crate::surface::hazard_class(water[i], speed[i]);
                if class > peak_class[i] { peak_class[i] = class; }
            }
            if arrival[i] < 0.0 && eta[i] >= arrival_depth { arrival[i] = t_end; }
        }
        self.boundary_volume += sponge_exchange;
        for (k, p) in self.probes.iter().enumerate() { if self.probe_arrival[k] < 0.0 && self.eta[*p].abs() > self.probe_threshold { self.probe_arrival[k] = t_end; } }
        self.time += dt;
        self.dt = self.stable_dt();
        self.scratch = delta;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uneven_lake_and_dry_shore_remain_at_rest() {
        for order in [1u8, 2] {
            let bed: Vec<f64> = (0..40*12).map(|i| -2.0 + (i % 40) as f64 * 0.12).collect();
            let h: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
            let mut s = Solver::new(40, 12, 25.0, bed, h.clone(), vec![0.0; h.len()], false, 0.025).unwrap();
            s.set_order(order).unwrap();
            s.advance(200).unwrap();
            assert!(s.water.iter().zip(h).all(|(a, b)| (a - b).abs() < 1e-12));
            assert!(s.speed.iter().all(|v| *v < 1e-12));
        }
    }
    #[test]
    fn dry_bed_dam_break_is_positive_conservative_and_moves_at_expected_speed() {
        for order in [1u8, 2] {
            // Ritter's solution: x(h) = (2 sqrt(g H) - 3 sqrt(g h)) t.
            // Compare the 1 cm contour, not the mathematically zero-depth front.
            let (w, h) = (240, 8);
            let initial: Vec<f64> = (0..w*h).map(|i| if i % w < 60 { 1.0 } else { 0.0 }).collect();
            let mut s = Solver::new(w, h, 1.0, vec![0.0; w*h], initial, vec![0.0; w*h], false, 0.0).unwrap();
            s.set_order(order).unwrap();
            while s.time < 8.0 { s.advance(1).unwrap(); }
            assert!(s.water.iter().all(|v| v.is_finite() && *v >= 0.0));
            assert!(s.volume_error().abs() < 1e-9);
            let front = (60..w).filter(|x| s.water[*x] > 0.01).max().unwrap();
            let expected = 60.0 + (2.0 * G.sqrt() - 3.0 * (G * 0.01).sqrt()) * s.time;
            assert!((front as f64 - expected).abs() < 10.0, "front {front}, expected {expected}");
            assert!(s.water[75] > 0.1);
            let c = G.sqrt();
            let mean_error = (0..w).map(|x| {
                let similarity = (x as f64 + 0.5 - 60.0) / s.time;
                let exact = if similarity < -c { 1.0 } else if similarity > 2.0*c { 0.0 }
                    else { (2.0*c - similarity).powi(2) / (9.0*G) };
                (s.water[x] - exact).abs()
            }).sum::<f64>() / w as f64;
            assert!(mean_error < 0.015, "Ritter depth mean absolute error {mean_error}");
        }
    }
    // A reservoir of depth h0 behind a one-cell wall that gives way. The discharge through the gap is Ritter's: q = (8/27) sqrt(g) h0^1.5 per metre
    // of width once the gap is open, and a slower opening gives a smaller and later peak. Water is conserved, the peaks are recorded every step,
    // and the first arrival of water grows with the distance from the wall.
    fn reservoir(w: usize, wall: usize, h0: f64, order: u8) -> Solver {
        let h = 6;
        let bed: Vec<f64> = (0..w * h).map(|i| if i % w == wall { h0 + 6.0 } else { 0.0 }).collect();
        let reference: Vec<f64> = (0..w * h).map(|i| if i % w < wall { h0 } else { 0.0 }).collect();
        let mut s = Solver::new(w, h, 2.0, bed, reference, vec![0.0; w * h], false, 0.0).unwrap();
        s.set_order(order).unwrap();
        s
    }
    #[test]
    fn a_wall_that_gives_way_releases_ritters_discharge_and_records_the_worst_hazard() {
        let (w, wall, h0) = (200usize, 100usize, 4.0_f64);
        let ritter = 8.0 / 27.0 * G.sqrt() * h0.powf(1.5);
        for order in [1u8, 2] {
            let mut s = reservoir(w, wall, h0, order);
            s.set_breach((0..6).map(|r| r * w + wall).collect(), vec![0.0; 6], 0.0, 0.0).unwrap();
            let mut flux = Vec::new();
            while s.time < 10.0 {
                s.advance(1).unwrap();
                if s.time > 4.0 { flux.push(s.mx[2 * w + wall]); }
            }
            let mean = flux.iter().sum::<f64>() / flux.len() as f64;
            assert!((mean - ritter).abs() < 0.15 * ritter, "order {order}: discharge {mean} against Ritter's {ritter}");
            assert!(s.volume_error().abs() < 1e-8 && s.water.iter().all(|v| v.is_finite() && *v >= 0.0));
            // the worst class near the gap is the top one and falls away downstream; nothing upstream of the lake's own water is flagged dry
            assert_eq!(s.peak_class[2 * w + wall + 1], 6);
            assert!(s.peak_class[2 * w + wall + 20] <= s.peak_class[2 * w + wall + 1]);
            assert!(s.peak_speed[2 * w + wall + 1] > 3.0 && s.peak_depth[2 * w + wall + 1] > 1.0);
            // arrival: later further from the wall, and never for cells the water did not reach
            let t = |k: usize| s.arrival[2 * w + wall + k];
            assert!(t(1) > 0.0 && t(5) > t(1) && t(15) > t(5), "arrivals {} {} {}", t(1), t(5), t(15));
            assert_eq!(s.arrival[2 * w + 2], -1.0, "the lake's own cells never see a rise of 10 cm");
            // the deepest water came later further out than at the gap's edge, and never before the wall gave way; the summary counts the land the water reached
            assert!(s.peak_time[2 * w + wall + 1] > 0.0 && s.peak_time[2 * w + wall + 1] <= s.time);
            let land: Vec<u8> = (0..w * 6).map(|i| u8::from(i % w > wall)).collect();
            let summary = s.flood_summary(&land);
            assert!(summary.flooded_hectares > 0.0 && summary.max_land_depth > 1.0 && summary.flooded_now_hectares > 0.0 && summary.flooded_now_hectares <= summary.flooded_hectares + 1e-9);
            assert_eq!(s.flood_summary(&vec![0; w * 6]).flooded_hectares, 0.0);
        }
    }
    #[test]
    fn a_slow_breach_gives_a_later_smaller_peak_than_a_sudden_one() {
        // a short reservoir, so it drains while the gap opens and a slow opening cannot reach the full discharge
        let (w, wall, h0) = (200usize, 10usize, 4.0_f64);
        let run = |duration: f64| {
            let mut s = reservoir(w, wall, h0, 1);
            s.set_breach((0..6).map(|r| r * w + wall).collect(), vec![0.0; 6], 2.0, duration).unwrap();
            let mut peak = (0.0_f64, 0.0_f64);
            while s.time < 80.0 {
                s.advance(1).unwrap();
                let q = s.mx[2 * w + wall];
                if q > peak.0 { peak = (q, s.time); }
            }
            assert!(s.volume_error().abs() < 1e-8);
            peak
        };
        let (sudden, slow) = (run(0.0), run(40.0));
        assert!(slow.0 < 0.85 * sudden.0, "slow {} sudden {}", slow.0, sudden.0);
        assert!(slow.1 > sudden.1 + 5.0, "slow at {} sudden at {}", slow.1, sudden.1);
    }
    #[test]
    fn an_invalid_breach_is_refused() {
        let mut s = reservoir(40, 20, 2.0, 1);
        assert!(s.set_breach(vec![], vec![], 0.0, 1.0).is_err());
        assert!(s.set_breach(vec![1_000_000], vec![0.0], 0.0, 1.0).is_err());
        assert!(s.set_breach(vec![20], vec![f64::NAN], 0.0, 1.0).is_err());
        assert!(s.set_breach(vec![20], vec![0.0], -1.0, 1.0).is_err());
        assert!(s.set_arrival_depth(0.0).is_err());
        s.advance(1).unwrap();
        assert!(s.set_breach(vec![20], vec![0.0], 0.0, 1.0).is_err(), "not once the run has started");
    }
    #[test]
    fn disconnected_lake_keeps_its_own_level() {
        for order in [1u8, 2] {
            let bed: Vec<f64> = (0..60*8).map(|i| match i % 60 { 0..=19 => -5.0, 20..=39 => 8.0, _ => 1.0 }).collect();
            let h: Vec<f64> = bed.iter().map(|z| if *z == -5.0 { 5.0 } else if *z == 1.0 { 2.0 } else { 0.0 }).collect();
            let mut s = Solver::new(60, 8, 25.0, bed, h.clone(), vec![0.0; h.len()], false, 0.03).unwrap();
            s.set_order(order).unwrap();
            s.advance(200).unwrap();
            assert!(s.water.iter().zip(h).all(|(a, b)| (a - b).abs() < 1e-12));
        }
    }
    #[test]
    fn sponge_water_exchange_is_accounted_for() {
        for order in [1u8, 2] {
            let mut s = Solver::new(30, 20, 25.0, vec![-10.0; 600], vec![10.0; 600], vec![0.5; 600], true, 0.025).unwrap();
            s.set_order(order).unwrap();
            s.advance(200).unwrap();
            assert!(s.boundary_volume < 0.0);
            assert!(s.volume_error().abs() < 1e-6);
        }
    }
    #[test]
    fn wave_runs_up_a_beach_and_recedes() {
        for order in [1u8, 2] {
            let (w, h) = (80, 8);
            let bed: Vec<f64> = (0..w*h).map(|i| {
                let x = (i % w) as f64;
                if x < 40.0 { (x - 40.0) * 0.2 } else { (x - 40.0) * 0.04 }
            }).collect();
            let depth: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
            let eta = (0..w*h).map(|i| if depth[i] > 0.0 { 0.6 * (-((i % w) as f64 - 25.0).powi(2) / 16.0).exp() } else { 0.0 }).collect();
            let mut s = Solver::new(w, h, 10.0, bed, depth.clone(), eta, false, 0.025).unwrap();
            s.set_order(order).unwrap();
            let mut receded = false;
            for _ in 0..2000 {
                s.advance(1).unwrap();
                receded |= (0..w*h).any(|i| depth[i] == 0.0 && s.peak[i] > 0.05 && s.water[i] < 0.01);
            }
            assert!(s.peak.iter().enumerate().any(|(i, v)| depth[i] == 0.0 && *v > 0.05));
            assert!(receded, "the run-up must subsequently drain below 1 cm");
            assert!(s.volume_error().abs() < 1e-7);
        }
    }
    #[test]
    fn excluded_terrain_cells_remain_impermeable_and_conservative() {
        for order in [1u8, 2] {
            let (w, h) = (30, 12);
            let mut reference = vec![3.0; w*h];
            let mut mask = vec![1; w*h];
            for y in 0..h { mask[y*w+15] = 0; reference[y*w+15] = 0.0; }
            let eta = (0..w*h).map(|i| if i % w < 15 { 0.5 } else { 0.0 }).collect();
            let mut s = Solver::new(w, h, 25.0, vec![-3.0; w*h], reference, eta, false, 0.025).unwrap();
            s.set_order(order).unwrap();
            s.set_valid(mask.clone()).unwrap();
            s.advance(200).unwrap();
            assert!(s.water.iter().enumerate().all(|(i, v)| if mask[i] == 0 { *v == 0.0 } else if i % w > 15 { (*v - 3.0).abs() < 1e-12 } else { v.is_finite() && *v >= 0.0 }));
            assert!(s.volume_error().abs() < 1e-7);
            assert!(s.set_valid(vec![0; w*h]).is_err());
        }
    }
    // A flat strip of still water, 50 m deep, for one-dimensional coupling tests.
    fn strip(w: usize, cell: f64, eta: Vec<f64>) -> Solver {
        let h = 6;
        Solver::new(w, h, cell, vec![-50.0; w*h], vec![50.0; w*h], eta, false, 0.0).unwrap()
    }

    #[test]
    fn forced_edge_at_rest_keeps_still_water_and_exact_balance() {
        for order in [1u8, 2] {
            let (w, h) = (40, 12);
            let bed: Vec<f64> = (0..w*h).map(|i| -30.0 + (i % w) as f64 * 0.5).collect();
            let depth: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
            let mut s = Solver::new(w, h, 50.0, bed, depth.clone(), vec![0.0; w*h], false, 0.0).unwrap();
            s.set_order(order).unwrap();
            s.set_forcing(Edge::West, vec![0.0, 1000.0], vec![0.0; 2], 1).unwrap();
            s.set_forcing(Edge::North, vec![0.0, 1000.0], vec![0.0; 2 * 3], 3).unwrap();
            s.advance(200).unwrap();
            assert!(s.water.iter().zip(&depth).all(|(a, b)| (a - b).abs() < 1e-9));
            assert!(s.volume_error().abs() < 1e-6);
        }
    }

    #[test]
    fn forced_edge_admits_a_wave_that_matches_the_parent_model() {
        for order in [1u8, 2] {
            // Coarse linear model (400 m cells) records a pulse at x = 20 km; the
            // finer nonlinear model (100 m cells) starts there and must reproduce
            // the parent's waveform downstream at x = 26 km.
            let (cw, cc) = (200, 400.0);
            let eta: Vec<f64> = (0..cw*6).map(|i| 0.1 * (-0.5 * ((((i % cw) as f64 + 0.5) * cc - 10_000.0) / 3_200.0).powi(2)).exp()).collect();
            let mut parent = crate::tsunami::Solver::new(cw, 6, cc, vec![50.0; cw*6], eta, false).unwrap();
            parent.record(&[(20_000.0 / cc, 3.0), (26_000.0 / cc, 3.0)]).unwrap();
            while parent.time < 900.0 { parent.advance(50).unwrap(); }
            let r = parent.recorded().unwrap();
            let inflow: Vec<f64> = (0..r.times.len()).map(|k| r.values[k * 2]).collect();
            let truth: Vec<f64> = (0..r.times.len()).map(|k| r.values[k * 2 + 1]).collect();
            let mut s = strip(240, 100.0, vec![0.0; 240*6]);
            s.set_order(order).unwrap();
            s.set_forcing(Edge::West, r.times.clone(), inflow, 1).unwrap();
            let mut worst = 0.0_f64;
            let mut peak_truth = 0.0_f64;
            let mut k = 0;
            while s.time < 900.0 {
                s.advance(1).unwrap();
                while k + 1 < r.times.len() && r.times[k + 1] < s.time { k += 1; }
                let t = (s.time - r.times[k]) / (r.times[k + 1] - r.times[k]);
                let expected = truth[k] * (1.0 - t) + truth[k + 1] * t;
                let got = s.eta[3 * 240 + 60]; // 100 m cells: x = 20 km + 60.5 cells = 26.05 km
                worst = worst.max((got - expected).abs());
                peak_truth = peak_truth.max(expected.abs());
            }
            assert!(peak_truth > 0.04, "pulse never arrived: {peak_truth}");
            assert!(worst < 0.08 * peak_truth, "waveform error {worst} vs peak {peak_truth}");
            assert!(s.volume_error().abs() < 1e-3 * s.boundary_volume.abs().max(1.0));
            assert!(s.boundary_volume > 0.0);
        }
    }

    #[test]
    fn forced_edge_lets_outgoing_waves_leave_with_little_reflection() {
        for order in [1u8, 2] {
            let w = 240;
            let eta: Vec<f64> = (0..w*6).map(|i| 0.1 * (-0.5 * (((i % w) as f64 - 120.0) / 12.0).powi(2)).exp()).collect();
            let mut open = strip(w, 100.0, eta.clone());
            open.set_order(order).unwrap();
            for edge in [Edge::West, Edge::East] { open.set_forcing(edge, vec![0.0, 1.0e5], vec![0.0; 2], 1).unwrap(); }
            let mut wall = strip(w, 100.0, eta);
            wall.set_order(order).unwrap();
            // c = 22 m/s: both halves of the pulse reach an edge by 550 s and, if
            // reflected, are back near the centre by 1100 s.
            while open.time < 1200.0 { open.advance(1).unwrap(); wall.advance(1).unwrap(); }
            let largest = |s: &Solver| s.eta.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
            assert!(largest(&wall) > 0.02, "{}", largest(&wall));
            assert!(largest(&open) < 0.1 * largest(&wall), "open {} vs wall {}", largest(&open), largest(&wall));
        }
    }

    #[test]
    fn sea_level_forcing_raises_a_closed_basin_to_the_new_level_and_accounts_for_the_water() {
        for order in [1u8, 2] {
            // A rising tide: external level ramps 0 -> 0.5 m over 600 s, then holds.
            // The open edge must pass the water in, so the basin settles at the new
            // level (not at twice it) and the volume balance includes the inflow.
            let w = 60;
            let mut s = strip(w, 100.0, vec![0.0; w * 6]);
            s.set_order(order).unwrap();
            s.set_forcing(Edge::West, vec![0.0, 1.0e5], vec![0.0; 2], 1).unwrap();
            s.set_level(vec![0.0, 600.0, 1.0e5], vec![0.0, 0.5, 0.5]).unwrap();
            while s.time < 3000.0 { s.advance(1).unwrap(); }
            let mean = s.eta.iter().sum::<f64>() / s.eta.len() as f64;
            assert!((mean - 0.5).abs() < 0.03, "basin level {mean}");
            assert!(s.volume_error().abs() < 1e-5);
            assert!((s.boundary_volume - 0.5 * (w * 6) as f64 * 100.0 * 100.0).abs() < 0.06 * s.boundary_volume);
            assert!(s.set_level(vec![0.0], vec![0.0]).is_err());
            assert!(s.set_level(vec![0.0, 1.0], vec![0.0, f64::NAN]).is_err());
        }
    }

    #[test]
    fn forcing_is_validated_and_dry_edges_stay_walls() {
        let mut s = strip(20, 100.0, vec![0.0; 120]);
        assert!(s.set_forcing(Edge::West, vec![0.0], vec![0.0], 1).is_err());
        assert!(s.set_forcing(Edge::West, vec![1.0, 0.5], vec![0.0; 2], 1).is_err());
        assert!(s.set_forcing(Edge::West, vec![0.0, 1.0], vec![0.0; 3], 1).is_err());
        assert!(s.set_forcing(Edge::West, vec![0.0, 1.0], vec![f64::NAN, 0.0], 1).is_err());
        assert!(s.set_forcing(Edge::West, vec![0.0, 1.0], vec![99.0, 0.0], 1).is_err());
        s.set_forcing(Edge::West, vec![0.0, 1.0], vec![0.0; 2], 1).unwrap();
        assert!(s.set_forcing(Edge::West, vec![0.0, 1.0], vec![0.0; 2], 1).is_err());
        assert_eq!(s.forcing_end(), Some(1.0));
        // A land edge cannot be forced.
        let mut land = Solver::new(8, 8, 25.0, (0..64).map(|i| if i % 8 < 4 { -5.0 } else { 5.0 }).collect(),
            (0..64).map(|i| if i % 8 < 4 { 5.0 } else { 0.0 }).collect(), vec![0.0; 64], false, 0.0).unwrap();
        assert!(land.set_forcing(Edge::East, vec![0.0, 1.0], vec![0.0; 2], 1).is_err());
        assert!(land.set_forcing(Edge::West, vec![0.0, 1.0], vec![0.0; 2], 1).is_ok());
    }

    // Run-up of a non-breaking solitary wave (height/depth ratio `ratio`) on a
    // 1:`cot` beach, in units where the depth is 6 m and the cells are `cell` m.
    fn solitary_runup(cell: f64, cot: f64, ratio: f64, order: u8) -> (f64, f64) {
        let (d, slope) = (6.0_f64, 1.0 / cot);
        let height = ratio * d;
        let k = (3.0 * height / (4.0 * d.powi(3))).sqrt();
        // Start where the wave is 5% of its crest height, as in Synolakis (1987).
        let ahead = (20.0_f64.sqrt()).acosh() / k;
        let behind = 2.4 / k;
        let toe = behind + ahead;
        let length = toe + d * cot + 0.3 * d * cot + 5.0 * cell;
        let w = (length / cell).ceil() as usize;
        assert!(w <= 512, "{w} cells");
        let h = 4;
        let x_of = |i: usize| ((i % w) as f64 + 0.5) * cell;
        let bed: Vec<f64> = (0..w*h).map(|i| { let x = x_of(i); if x < toe { -d } else { -d + (x - toe) * slope } }).collect();
        let still: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
        let eta: Vec<f64> = (0..w*h).map(|i| if still[i] > 0.0 { height / (k * (x_of(i) - behind)).cosh().powi(2) } else { 0.0 }).collect();
        let c = (G * (d + height)).sqrt();
        // Right-going wave: u = c eta / (d + eta), transport = (d + eta) u.
        let mx: Vec<f64> = (0..w*h).map(|i| if still[i] > 0.0 { c * eta[i] } else { 0.0 }).collect();
        let mut s = Solver::new(w, h, cell, bed, still, eta, false, 0.0).unwrap();
        s.set_order(order).unwrap();
        s.set_momentum(mx, vec![0.0; w*h]).unwrap();
        let mut run_up = 0.0_f64;
        // Transit to the toe, up and down the beach, with margin.
        while s.time < ahead / c + 3.0 * d * cot / c + 20.0 {
            s.advance(1).unwrap();
            for x in 0..w {
                let i = 2 * w + x;
                if s.water[i] > 0.003 * d { run_up = run_up.max(s.bed[i] + s.water[i]); }
            }
        }
        assert!(s.volume_error().abs() < 1e-6);
        (run_up, 2.831 * cot.sqrt() * ratio.powf(1.25) * d)
    }

    #[test]
    fn solitary_wave_runup_follows_the_synolakis_law() {
        // NOAA/NCTR analytical benchmark: R/d = 2.831 sqrt(cot beta) (H/d)^(5/4).
        // Ratio 0.05 on 1:10 is below Synolakis' breaking limit
        // 0.818 cot^(-10/9) (about 0.063), so the law applies.
        let (coarse, expected) = solitary_runup(1.0, 10.0, 0.05, 1);
        let (fine, _) = solitary_runup(0.5, 10.0, 0.05, 1);
        eprintln!("run-up cell 1 m: {coarse:.3}, cell 0.5 m: {fine:.3}, Synolakis {expected:.3}");
        assert!(fine > coarse, "refinement should raise the first-order solution");
        assert!((fine - expected).abs() < 0.2 * expected, "run-up {fine:.4} m, Synolakis {expected:.4} m");
    }

    // Thacker's sloshing water body in a parabolic bowl (bed z = h0 x^2 / a^2 - D, a one-
    // dimensional strip): the exact nonlinear, frictionless solution is a parabolic body of water
    // that slides back and forth without changing shape,
    //   h(x, t) = max(0, D - h0 (x - xi(t))^2 / a^2),  u = xi'(t),  xi(t) = xi0 cos(omega t),
    // omega = sqrt(2 g h0) / a, so both shorelines move through dry cells and back. Returns, for
    // eight times a period, the worst error against that solution.
    struct Bowl { l1: f64, shoreline: f64, volume: f64, amplitude: f64 }
    fn thacker_bowl(cell: f64, order: u8, periods: f64) -> Bowl {
        let (a, h0, depth, xi0) = (100.0_f64, 1.0_f64, 0.5_f64, 20.0_f64);
        let omega = (2.0 * G * h0).sqrt() / a;
        let period = 2.0 * std::f64::consts::PI / omega;
        let half_width = a * (depth / h0).sqrt();
        let w = (2.0 * (half_width + 2.0 * xi0 + 20.0) / cell).ceil() as usize;
        let h = 4;
        let x_of = |i: usize| ((i % w) as f64 + 0.5) * cell - w as f64 * cell / 2.0;
        let bed: Vec<f64> = (0..w*h).map(|i| h0 * x_of(i).powi(2) / (a * a) - depth).collect();
        let still: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
        let exact = |x: f64, t: f64| (depth - h0 * (x - xi0 * (omega * t).cos()).powi(2) / (a * a)).max(0.0);
        let eta: Vec<f64> = (0..w*h).map(|i| exact(x_of(i), 0.0) - still[i]).collect();
        let mut s = Solver::new(w, h, cell, bed, still, eta, false, 0.0).unwrap();
        s.set_order(order).unwrap();
        let (mut l1, mut mass, mut shoreline, mut amplitude) = (0.0_f64, 0.0_f64, 0.0_f64, 0.0_f64);
        let mut next = period / 8.0;
        let mut sampled = 0;
        let mut start_volume = None;
        while s.time < periods * period {
            s.advance(1).unwrap();
            if start_volume.is_none() { start_volume = Some((0..w).map(|x| s.water[2 * w + x]).sum::<f64>() * cell); }
            if s.time >= next {
                next += period / 8.0;
                let (mut err, mut tot, mut right) = (0.0, 0.0, f64::NEG_INFINITY);
                for x in 0..w {
                    let (model, truth) = (s.water[2 * w + x], exact(x_of(x), s.time));
                    err += (model - truth).abs(); tot += truth;
                    if model > 0.003 { right = right.max(x_of(x)); }
                }
                l1 = l1.max(err / tot);
                // the right shoreline against xi(t) + half_width
                shoreline = shoreline.max((right - (xi0 * (omega * s.time).cos() + half_width)).abs());
                mass = mass.max(((0..w).map(|x| s.water[2 * w + x]).sum::<f64>() * cell - start_volume.unwrap()).abs());
                amplitude = amplitude.max(right - half_width);
                sampled += 1;
            }
        }
        assert!(sampled >= (8.0 * periods) as usize - 1);
        Bowl { l1, shoreline, volume: mass, amplitude }
    }

    #[test]
    fn thacker_bowl_tracks_two_moving_shorelines_and_second_order_keeps_the_oscillation() {
        // Five periods of an exact nonlinear oscillation that wets and dries both shorelines.
        // Measured: worst L1 depth error (of the water present) over the run, and the worst
        // error of the right shoreline: first order 2 m cells 27% and 15 m, 1 m cells 15% and
        // 8.4 m; second order 2 m cells 4.4% and 5.4 m, 1 m cells 1.7% and 1.8 m.
        let (first_coarse, first_fine) = (thacker_bowl(2.0, 1, 5.0), thacker_bowl(1.0, 1, 5.0));
        let (second_coarse, second_fine) = (thacker_bowl(2.0, 2, 5.0), thacker_bowl(1.0, 2, 5.0));
        for (name, b) in [("first 2 m", &first_coarse), ("first 1 m", &first_fine), ("second 2 m", &second_coarse), ("second 1 m", &second_fine)] {
            eprintln!("thacker {name}: worst L1 {:.4}, shoreline error {:.2} m, volume drift {:.2e}", b.l1, b.shoreline, b.volume);
            // the water body is only ever moved around: no water made or lost
            assert!(b.volume < 1e-9, "{name}: volume drift {}", b.volume);
            // the shoreline reaches most of the way to its exact excursion (20 m)
            assert!(b.amplitude > 15.0, "{name}: excursion {}", b.amplitude);
        }
        assert!(first_fine.l1 < first_coarse.l1 && second_fine.l1 < second_coarse.l1, "refinement should reduce the error");
        assert!(first_fine.shoreline < first_coarse.shoreline && second_fine.shoreline < second_coarse.shoreline);
        assert!(first_fine.l1 < 0.20, "first order, 1 m cells: {}", first_fine.l1);
        assert!(second_fine.l1 < 0.03 && second_coarse.l1 < 0.06, "second order: {} and {}", second_fine.l1, second_coarse.l1);
        assert!(second_fine.l1 < first_fine.l1 / 4.0, "second order should keep the shape several times better");
        assert!(second_fine.shoreline < 3.0, "second order shoreline error {} m", second_fine.shoreline);
    }

    // Where the time goes on a 160 x 96 scene like the bundled local terrains (run with --ignored --nocapture).
    #[test]
    #[ignore]
    fn time_the_steps() {
        let (w, h, cell) = (160usize, 96usize, 50.0_f64);
        let bed: Vec<f64> = (0..w * h).map(|i| { let x = (i % w) as f64; if x < 80.0 { -(40.0 - x * 0.5) } else { (x - 80.0) * 0.1 } }).collect();
        let still: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
        let eta: Vec<f64> = (0..w * h).map(|i| if still[i] > 0.0 { 0.8 * (-(((i % w) as f64 - 40.0).powi(2) + ((i / w) as f64 - 48.0).powi(2)) / 50.0).exp() } else { 0.0 }).collect();
        for order in [1u8, 2] {
            let mut s = Solver::new(w, h, cell, bed.clone(), still.clone(), eta.clone(), true, 0.025).unwrap();
            s.set_order(order).unwrap();
            // a second scene with a forced edge, a tide, a mask and no sponge, only for the checksum
            let mut f = Solver::new(w, h, cell, bed.clone(), still.clone(), vec![0.0; w * h], false, 0.03).unwrap();
            f.set_order(order).unwrap();
            f.set_valid((0..w * h).map(|i| u8::from(!((i % w) > 120 && (i / w) % 9 == 4))).collect()).unwrap();
            f.set_forcing(Edge::West, (0..20).map(|k| k as f64 * 60.0).collect(), (0..20).map(|k| 0.6 * (k as f64 * 0.7).sin()).collect(), 1).unwrap();
            f.set_level((0..20).map(|k| k as f64 * 60.0).collect(), (0..20).map(|k| 0.02 * k as f64).collect()).unwrap();
            for _ in 0..(if order == 1 { 15 } else { 6 }) { f.advance(100).unwrap(); }
            let fsum = |v: &[f64]| v.iter().fold(0xcbf29ce484222325u64, |a, x| (a ^ x.to_bits()).wrapping_mul(0x100000001b3).rotate_left(5));
            eprintln!("order {order}: forced checksum water {:016x} mx {:016x} my {:016x} volume error {:.3e}", fsum(&f.water), fsum(&f.mx), fsum(&f.my), f.volume_error());
            let steps = std::env::var("STEPS").ok().and_then(|v| v.parse().ok()).unwrap_or(if order == 1 { 3000 } else { 1000 });
            let t = std::time::Instant::now();
            for _ in 0..steps / 200 { s.advance(200).unwrap(); }
            let each = t.elapsed().as_secs_f64() / steps as f64;
            if let Ok(dir) = std::env::var("STATE_OUT") {
                for (name, state) in [("a", &s), ("forced", &f)] {
                    let bytes: Vec<u8> = [&state.water, &state.mx, &state.my].iter().flat_map(|v| v.iter().flat_map(|x| x.to_le_bytes())).collect();
                    std::fs::write(format!("{dir}/{name}-order{order}.bin"), bytes).unwrap();
                }
            }
            let sum = |v: &[f64]| v.iter().fold(0xcbf29ce484222325u64, |a, x| (a ^ x.to_bits()).wrapping_mul(0x100000001b3).rotate_left(5));
            eprintln!("order {order}: checksum water {:016x} mx {:016x} my {:016x}", sum(&s.water), sum(&s.mx), sum(&s.my));
            eprintln!("order {order}: {:.1} us per step, {:.1} ns per cell-step, dt {:.3} s", each * 1e6, each * 1e9 / (w * h) as f64, s.dt);
            let t = std::time::Instant::now();
            for _ in 0..200 { std::hint::black_box(s.stable_dt()); }
            eprintln!("  stable_dt: {:.1} us", t.elapsed().as_secs_f64() / 200.0 * 1e6);
            if order == 1 {
                let t = std::time::Instant::now();
                for _ in 0..200 { std::hint::black_box(s.first_order_delta(1.0)); }
                eprintln!("  first_order_delta: {:.1} us", t.elapsed().as_secs_f64() / 200.0 * 1e6);
            } else {
                let vel: Vec<(f64, f64)> = (0..w * h).map(|i| if s.water[i] > DRY { (s.mx[i] / s.water[i], s.my[i] / s.water[i]) } else { (0.0, 0.0) }).collect();
                let mut buf = Vec::new();
                let t = std::time::Instant::now();
                for _ in 0..200 { s.reconstruct(0, &s.water, &vel, &mut buf); std::hint::black_box(&buf); }
                eprintln!("  one reconstruct: {:.1} us", t.elapsed().as_secs_f64() / 200.0 * 1e6);
                let mut recon = [Vec::new(), Vec::new()];
                let t = std::time::Instant::now();
                for _ in 0..200 { std::hint::black_box(s.rate(&s.water, &s.mx, &s.my, 0.0, &mut recon)); }
                eprintln!("  one rate (2 reconstructs + fluxes + source): {:.1} us", t.elapsed().as_secs_f64() / 200.0 * 1e6);
            }
        }
    }

    #[test]
    fn second_order_scheme_removes_most_of_the_run_up_deficit() {
        // Same Synolakis benchmark as above. The first-order scheme reaches 83% of
        // the analytical run-up at 0.5 m cells; the second-order scheme reaches 98%.
        let (fine, expected) = solitary_runup(0.5, 10.0, 0.05, 2);
        eprintln!("second order run-up at 0.5 m cells: {fine:.3}, Synolakis {expected:.3}");
        assert!((fine - expected).abs() < 0.06 * expected, "0.5 m cells: {fine:.4} vs {expected:.4}");
    }

    #[test]
    fn order_must_be_valid_and_set_before_the_run() {
        let mut s = Solver::new(8, 8, 25.0, vec![-5.0; 64], vec![5.0; 64], vec![0.0; 64], false, 0.025).unwrap();
        assert!(s.set_order(3).is_err());
        s.set_order(2).unwrap();
        s.advance(1).unwrap();
        assert!(s.set_order(1).is_err());
    }

    #[test]
    fn invalid_water_and_inputs_are_rejected() {
        assert!(Solver::new(4, 4, 25.0, vec![-1.0; 16], vec![1.0; 16], vec![-2.0; 16], false, 0.025).is_err());
        assert!(Solver::new(4, 4, 25.0, vec![f64::NAN; 16], vec![1.0; 16], vec![0.0; 16], false, 0.025).is_err());
    }
}
