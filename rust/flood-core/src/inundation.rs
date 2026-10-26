//! Experimental nonlinear 2-D shallow-water equations with wetting/drying.
//! First-order Rusanov flux + Audusse et al. (2004) hydrostatic reconstruction.
//! Bed and initial water depth are separate: disconnected lakes keep their level.
//! Reflecting walls, optional relaxation sponge, semi-implicit Manning friction.
const G: f64 = 9.81;
const DRY: f64 = 1e-7;

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
    level: Option<(Vec<f64>, Vec<f64>)>,
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
        let mut s = Self { w, h, cell, bed, water, reference, peak: eta.iter().map(|e| e.abs()).collect(), eta,
            speed: vec![0.0; n], time: 0.0, dt: 0.0, boundary_volume: 0.0, initial_volume,
            valid: vec![true; n], mx: vec![0.0; n], my: vec![0.0; n], sponge, roughness, forcing: Vec::new(), level: None };
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

    fn level_at(&self) -> f64 {
        let Some((times, values)) = &self.level else { return 0.0 };
        let k = times.partition_point(|t| *t <= self.time).clamp(1, times.len() - 1);
        let f = ((self.time - times[k - 1]) / (times[k] - times[k - 1])).clamp(0.0, 1.0);
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
    fn forced_flux(&self, edge: Edge, k: usize, axis: usize) -> Option<[f64; 3]> {
        let f = self.forcing.iter().find(|f| f.edge == edge)?;
        if !self.edge_wet(edge, k) { return None; }
        let i = self.edge_cell(edge, k);
        let h = self.water[i];
        if h <= DRY { return None; }
        let sign = if matches!(edge, Edge::East | Edge::South) { 1.0 } else { -1.0 };
        let still = self.reference[i].max(h);
        let eta_in = f.at((k as f64 + 0.5) / self.edge_len(edge) as f64, self.time);
        let c = (G * still).sqrt();
        let outward = ((G / still).sqrt() * (h - self.reference[i] - self.level_at() - 2.0 * eta_in)).clamp(-2.0 * c, 2.0 * c);
        let u = sign * outward;
        let tangent = 3 - axis;
        let mut flux = [h * u, 0.0, 0.0];
        flux[axis] = h * u * u + 0.5 * G * h * h;
        // Tangential momentum leaves with outflow; inflow brings none.
        flux[tangent] = if outward > 0.0 { u * [0.0, self.mx[i], self.my[i]][tangent] / h } else { 0.0 };
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
        0.4 * self.cell / maximum.max(1e-6)
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

    fn step(&mut self) -> Result<(), String> {
        let dt = self.stable_dt();
        let ratio = dt / self.cell;
        let mut delta = vec![[0.0; 3]; self.water.len()];
        // Include mirrored ghost states at outer walls. Each interior face is
        // evaluated once, so its mass exchange is exactly equal and opposite.
        for axis in [1, 2] {
            let (across, along) = if axis == 1 { (self.w, self.h) } else { (self.h, self.w) };
            for row in 0..along { for face in 0..=across {
                let index = |col: usize| if axis == 1 { row * self.w + col } else { col * self.w + row };
                let li = index(face.saturating_sub(1));
                let ri = index(face.min(across - 1));
                if !self.valid[li] && !self.valid[ri] { continue; }
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
                    self.forced_flux(edge, row, axis).map(|f| (f, edge))
                } else { None };
                let (flux, cl, cr) = if let Some((f, edge)) = boundary {
                    // Mass entering the domain, in m3, through this face.
                    let inflow = if matches!(edge, Edge::West | Edge::North) { f[0] } else { -f[0] } * dt * self.cell;
                    self.boundary_volume += inflow;
                    (f, 0.0, 0.0)
                } else {
                    Self::face(left, right, zl, zr, axis)
                };
                for k in 0..3 {
                    if face > 0 && self.valid[li] { delta[li][k] -= ratio * (flux[k] + if k == axis { cl } else { 0.0 }); }
                    if face < across && self.valid[ri] { delta[ri][k] += ratio * (flux[k] + if k == axis { cr } else { 0.0 }); }
                }
            } }
        }
        for (i, d) in delta.iter().enumerate() {
            let h = self.water[i] + d[0];
            if !h.is_finite() || h < -1e-9 { return Err("inundation solver lost positivity; reset the scene".into()); }
            self.water[i] = h.max(0.0);
            self.mx[i] += d[1]; self.my[i] += d[2];
            if self.water[i] <= DRY { self.mx[i] = 0.0; self.my[i] = 0.0; }
            else {
                let speed = self.mx[i].hypot(self.my[i]) / self.water[i];
                let friction = 1.0 + dt * G * self.roughness.powi(2) * speed / self.water[i].powf(4.0 / 3.0);
                self.mx[i] /= friction; self.my[i] /= friction;
            }
            if self.sponge[i] > 0.0 {
                let damping = (-self.sponge[i] * dt / 20.0).exp();
                let previous = self.water[i];
                self.water[i] = self.reference[i] + (previous - self.reference[i]) * damping;
                self.boundary_volume += (self.water[i] - previous) * self.cell * self.cell;
                self.mx[i] *= damping; self.my[i] *= damping;
            }
            self.eta[i] = self.water[i] - self.reference[i];
            self.peak[i] = self.peak[i].max(self.eta[i].abs());
            self.speed[i] = if self.water[i] > DRY { self.mx[i].hypot(self.my[i]) / self.water[i] } else { 0.0 };
            if !self.speed[i].is_finite() { return Err("non-finite inundation velocity".into()); }
        }
        self.time += dt;
        self.dt = self.stable_dt();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uneven_lake_and_dry_shore_remain_at_rest() {
        let bed: Vec<f64> = (0..40*12).map(|i| -2.0 + (i % 40) as f64 * 0.12).collect();
        let h: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
        let mut s = Solver::new(40, 12, 25.0, bed, h.clone(), vec![0.0; h.len()], false, 0.025).unwrap();
        s.advance(200).unwrap();
        assert!(s.water.iter().zip(h).all(|(a, b)| (a - b).abs() < 1e-12));
        assert!(s.speed.iter().all(|v| *v < 1e-12));
    }
    #[test]
    fn dry_bed_dam_break_is_positive_conservative_and_moves_at_expected_speed() {
        // Ritter's solution: x(h) = (2 sqrt(g H) - 3 sqrt(g h)) t.
        // Compare the 1 cm contour, not the mathematically zero-depth front.
        let (w, h) = (240, 8);
        let initial: Vec<f64> = (0..w*h).map(|i| if i % w < 60 { 1.0 } else { 0.0 }).collect();
        let mut s = Solver::new(w, h, 1.0, vec![0.0; w*h], initial, vec![0.0; w*h], false, 0.0).unwrap();
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
    #[test]
    fn disconnected_lake_keeps_its_own_level() {
        let bed: Vec<f64> = (0..60*8).map(|i| match i % 60 { 0..=19 => -5.0, 20..=39 => 8.0, _ => 1.0 }).collect();
        let h: Vec<f64> = bed.iter().map(|z| if *z == -5.0 { 5.0 } else if *z == 1.0 { 2.0 } else { 0.0 }).collect();
        let mut s = Solver::new(60, 8, 25.0, bed, h.clone(), vec![0.0; h.len()], false, 0.03).unwrap();
        s.advance(200).unwrap();
        assert!(s.water.iter().zip(h).all(|(a, b)| (a - b).abs() < 1e-12));
    }
    #[test]
    fn sponge_water_exchange_is_accounted_for() {
        let mut s = Solver::new(30, 20, 25.0, vec![-10.0; 600], vec![10.0; 600], vec![0.5; 600], true, 0.025).unwrap();
        s.advance(200).unwrap();
        assert!(s.boundary_volume < 0.0);
        assert!(s.volume_error().abs() < 1e-6);
    }
    #[test]
    fn wave_runs_up_a_beach_and_recedes() {
        let (w, h) = (80, 8);
        let bed: Vec<f64> = (0..w*h).map(|i| {
            let x = (i % w) as f64;
            if x < 40.0 { (x - 40.0) * 0.2 } else { (x - 40.0) * 0.04 }
        }).collect();
        let depth: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
        let eta = (0..w*h).map(|i| if depth[i] > 0.0 { 0.6 * (-((i % w) as f64 - 25.0).powi(2) / 16.0).exp() } else { 0.0 }).collect();
        let mut s = Solver::new(w, h, 10.0, bed, depth.clone(), eta, false, 0.025).unwrap();
        let mut receded = false;
        for _ in 0..2000 {
            s.advance(1).unwrap();
            receded |= (0..w*h).any(|i| depth[i] == 0.0 && s.peak[i] > 0.05 && s.water[i] < 0.01);
        }
        assert!(s.peak.iter().enumerate().any(|(i, v)| depth[i] == 0.0 && *v > 0.05));
        assert!(receded, "the run-up must subsequently drain below 1 cm");
        assert!(s.volume_error().abs() < 1e-7);
    }
    #[test]
    fn excluded_terrain_cells_remain_impermeable_and_conservative() {
        let (w, h) = (30, 12);
        let mut reference = vec![3.0; w*h];
        let mut mask = vec![1; w*h];
        for y in 0..h { mask[y*w+15] = 0; reference[y*w+15] = 0.0; }
        let eta = (0..w*h).map(|i| if i % w < 15 { 0.5 } else { 0.0 }).collect();
        let mut s = Solver::new(w, h, 25.0, vec![-3.0; w*h], reference, eta, false, 0.025).unwrap();
        s.set_valid(mask.clone()).unwrap();
        s.advance(200).unwrap();
        assert!(s.water.iter().enumerate().all(|(i, v)| if mask[i] == 0 { *v == 0.0 } else if i % w > 15 { (*v - 3.0).abs() < 1e-12 } else { v.is_finite() && *v >= 0.0 }));
        assert!(s.volume_error().abs() < 1e-7);
        assert!(s.set_valid(vec![0; w*h]).is_err());
    }
    // A flat strip of still water, 50 m deep, for one-dimensional coupling tests.
    fn strip(w: usize, cell: f64, eta: Vec<f64>) -> Solver {
        let h = 6;
        Solver::new(w, h, cell, vec![-50.0; w*h], vec![50.0; w*h], eta, false, 0.0).unwrap()
    }

    #[test]
    fn forced_edge_at_rest_keeps_still_water_and_exact_balance() {
        let (w, h) = (40, 12);
        let bed: Vec<f64> = (0..w*h).map(|i| -30.0 + (i % w) as f64 * 0.5).collect();
        let depth: Vec<f64> = bed.iter().map(|z| (-z).max(0.0)).collect();
        let mut s = Solver::new(w, h, 50.0, bed, depth.clone(), vec![0.0; w*h], false, 0.0).unwrap();
        s.set_forcing(Edge::West, vec![0.0, 1000.0], vec![0.0; 2], 1).unwrap();
        s.set_forcing(Edge::North, vec![0.0, 1000.0], vec![0.0; 2 * 3], 3).unwrap();
        s.advance(200).unwrap();
        assert!(s.water.iter().zip(&depth).all(|(a, b)| (a - b).abs() < 1e-9));
        assert!(s.volume_error().abs() < 1e-6);
    }

    #[test]
    fn forced_edge_admits_a_wave_that_matches_the_parent_model() {
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

    #[test]
    fn forced_edge_lets_outgoing_waves_leave_with_little_reflection() {
        let w = 240;
        let eta: Vec<f64> = (0..w*6).map(|i| 0.1 * (-0.5 * (((i % w) as f64 - 120.0) / 12.0).powi(2)).exp()).collect();
        let mut open = strip(w, 100.0, eta.clone());
        for edge in [Edge::West, Edge::East] { open.set_forcing(edge, vec![0.0, 1.0e5], vec![0.0; 2], 1).unwrap(); }
        let mut wall = strip(w, 100.0, eta);
        // c = 22 m/s: both halves of the pulse reach an edge by 550 s and, if
        // reflected, are back near the centre by 1100 s.
        while open.time < 1200.0 { open.advance(1).unwrap(); wall.advance(1).unwrap(); }
        let largest = |s: &Solver| s.eta.iter().fold(0.0_f64, |m, v| m.max(v.abs()));
        assert!(largest(&wall) > 0.02, "{}", largest(&wall));
        assert!(largest(&open) < 0.1 * largest(&wall), "open {} vs wall {}", largest(&open), largest(&wall));
    }

    #[test]
    fn sea_level_forcing_raises_a_closed_basin_to_the_new_level_and_accounts_for_the_water() {
        // A rising tide: external level ramps 0 -> 0.5 m over 600 s, then holds.
        // The open edge must pass the water in, so the basin settles at the new
        // level (not at twice it) and the volume balance includes the inflow.
        let w = 60;
        let mut s = strip(w, 100.0, vec![0.0; w * 6]);
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
    fn solitary_runup(cell: f64, cot: f64, ratio: f64) -> (f64, f64) {
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
        let (coarse, expected) = solitary_runup(1.0, 10.0, 0.05);
        let (fine, _) = solitary_runup(0.5, 10.0, 0.05);
        eprintln!("run-up cell 1 m: {coarse:.3}, cell 0.5 m: {fine:.3}, Synolakis {expected:.3}");
        assert!(fine > coarse, "refinement should raise the first-order solution");
        assert!((fine - expected).abs() < 0.2 * expected, "run-up {fine:.4} m, Synolakis {expected:.4} m");
    }

    #[test]
    fn invalid_water_and_inputs_are_rejected() {
        assert!(Solver::new(4, 4, 25.0, vec![-1.0; 16], vec![1.0; 16], vec![-2.0; 16], false, 0.025).is_err());
        assert!(Solver::new(4, 4, 25.0, vec![f64::NAN; 16], vec![1.0; 16], vec![0.0; 16], false, 0.025).is_err());
    }
}
