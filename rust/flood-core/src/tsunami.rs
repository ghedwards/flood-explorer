//! Idealised long-wave propagation on fixed bathymetry (metres below sea level).
//! Linear SWE: eta_t = -div(q), q_t = -g H grad(eta).
//! Cell-centred eta and face-centred transport use staggered leapfrog time steps.
//! Land is a fixed reflecting wall; an optional outer sponge absorbs waves.
//! No wetting/drying, earthquake source physics, dispersion or inundation.

const G: f64 = 9.81;

#[derive(Clone, Copy, PartialEq)]
pub enum Method { Staggered, FiniteVolume, Dispersive }

pub struct Solver {
    pub w: usize,
    pub h: usize,
    pub cell: f64,
    pub depth: Vec<f64>,
    pub eta: Vec<f64>,
    pub peak: Vec<f64>,
    pub time: f64,
    pub dt: f64,
    pub steps: usize,
    pub method: Method,
    mx: Vec<f64>,
    my: Vec<f64>,
    qx: Vec<f64>,
    qy: Vec<f64>,
    damping: Vec<f64>,
    /// The sponge factor of every x face and y face (the geometric mean of the two cells either side),
    /// worked out once instead of a square root per face per step.
    damp_x: Vec<f64>,
    damp_y: Vec<f64>,
    filter: Option<crate::dispersion::Filter>,
    variable: Option<crate::dispersion::Variable>,
    /// Use the variable-depth dispersive operator even where the depth is
    /// uniform (it is selected automatically otherwise).
    pub force_variable_dispersion: bool,
    /// Relative residual of the variable-depth dispersive solve (see dispersion.rs).
    pub dispersion_tolerance: f64,
    recorder: Option<Recorder>,
}

/// Surface displacement sampled at fixed points (fractional cell coordinates,
/// cell centres at i + 0.5) after every step. Used as one-way boundary
/// forcing for a finer nested model.
/// Four cell indices and their weights: how a point reads the surface.
pub type Tap = [(usize, f64); 4];

/// Taps for points in any `w` x `h` grid whose still-water depths are `depth` (0 on land): see `Solver::make_taps`.
pub fn taps_over(w: usize, h: usize, depth: &[f64], points: &[(f64, f64)]) -> Result<Vec<Tap>, String> {
    let mut taps = Vec::with_capacity(points.len());
    for &(px, py) in points {
        if !px.is_finite() || !py.is_finite() || px < 0.5 || py < 0.5 || px > w as f64 - 0.5 || py > h as f64 - 0.5 {
            return Err("recording point outside the propagation grid".into());
        }
        let (fx, fy) = (px - 0.5, py - 0.5);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
        let mut tap = [(0, 0.0); 4];
        let mut total = 0.0;
        for (k, (dx, dy, weight)) in [(0, 0, (1.0 - tx) * (1.0 - ty)), (1, 0, tx * (1.0 - ty)), (0, 1, (1.0 - tx) * ty), (1, 1, tx * ty)].into_iter().enumerate() {
            let (x, y) = ((x0 + dx).min(w - 1), (y0 + dy).min(h - 1));
            let i = y * w + x;
            let weight = if depth[i] > 0.0 { weight } else { 0.0 };
            total += weight;
            tap[k] = (i, weight);
        }
        if total < 1e-9 { return Err("recording point is on land in the propagation grid".into()); }
        for t in &mut tap { t.1 /= total; }
        taps.push(tap);
    }
    Ok(taps)
}

pub struct Recorder {
    taps: Vec<Tap>,
    pub times: Vec<f64>,
    /// Row-major [sample][point].
    pub values: Vec<f64>,
    pub points: usize,
}

const MAX_RECORDED_VALUES: usize = 8_000_000;

impl Solver {
    pub fn new(w: usize, h: usize, cell: f64, depth: Vec<f64>, eta: Vec<f64>, absorbing: bool) -> Result<Self, String> {
        if !(4..=512).contains(&w) || !(4..=512).contains(&h)
            || !cell.is_finite() || cell < 1.0 || depth.len() != w * h || eta.len() != w * h {
            return Err("invalid tsunami grid (4–512 cells per side, cell size at least 1 m)".into());
        }
        if depth.iter().any(|v| !v.is_finite() || *v < 0.0 || *v > 12_000.0)
            || eta.iter().any(|v| !v.is_finite() || v.abs() > 100.0) {
            return Err("invalid ocean depths or initial displacement".into());
        }
        let max_depth = depth.iter().copied().fold(0.0_f64, f64::max);
        if max_depth <= 0.0 { return Err("the grid contains no ocean".into()); }
        if depth.iter().zip(&eta).any(|(d, e)| *d == 0.0 && *e != 0.0) {
            return Err("initial displacement must be zero on land".into());
        }
        let dt = 0.45 * cell / (G * max_depth).sqrt();
        let mut damping = vec![1.0; w * h];
        if absorbing {
            let width = (w.min(h) / 8).clamp(2, 16) as f64;
            for y in 0..h { for x in 0..w {
                let edge = x.min(w - 1 - x).min(y.min(h - 1 - y)) as f64;
                let strength = (1.0 - edge / width).max(0.0);
                damping[y * w + x] = (-0.12 * strength * strength).exp();
            } }
        }
        let mut damp_x = vec![1.0; (w + 1) * h];
        let mut damp_y = vec![1.0; w * (h + 1)];
        for y in 0..h { for x in 1..w { damp_x[y * (w + 1) + x] = (damping[y * w + x - 1] * damping[y * w + x]).sqrt(); } }
        for y in 1..h { for x in 0..w { damp_y[y * w + x] = (damping[(y - 1) * w + x] * damping[y * w + x]).sqrt(); } }
        Ok(Self { w, h, cell, peak: eta.iter().map(|v| v.abs()).collect(), depth, eta, time: 0.0, dt, steps: 0,
            qx: vec![0.0; (w + 1) * h], qy: vec![0.0; w * (h + 1)], damping, damp_x, damp_y, filter: None, variable: None, force_variable_dispersion: false, dispersion_tolerance: crate::dispersion::TOLERANCE,
            recorder: None, method: Method::Staggered, mx: vec![0.0; w * h], my: vec![0.0; w * h] })
    }

    /// Interpolation taps for points (fractional cell coordinates, cell centres at i + 0.5): the bilinear mean over each point's wet neighbours, so coastal points
    /// do not read the zero of reflecting land. Used by the recorder and by the nested model's live sampling.
    pub fn make_taps(&self, points: &[(f64, f64)]) -> Result<Vec<Tap>, String> { taps_over(self.w, self.h, &self.depth, points) }

    /// The depth-integrated transport at the centre of cell `i` (m2/s), the mean of the transports through its faces.
    pub fn centre_transport(&self, i: usize) -> (f64, f64) {
        let (x, y) = (i % self.w, i / self.w);
        (0.5 * (self.qx[y * (self.w + 1) + x] + self.qx[y * (self.w + 1) + x + 1]), 0.5 * (self.qy[y * self.w + x] + self.qy[(y + 1) * self.w + x]))
    }

    /// Move the transport through an interior x face (between cells x - 1 and x of row y) a share `alpha` of the way to `target` (m2/s). Only the staggered scheme has face
    /// transports; a face with land on either side is left alone.
    pub fn nudge_flux_x(&mut self, x: usize, y: usize, target: f64, alpha: f64) {
        if self.method == Method::FiniteVolume || x == 0 || x >= self.w || y >= self.h { return; }
        let right = y * self.w + x;
        if self.depth[right] > 0.0 && self.depth[right - 1] > 0.0 {
            let q = &mut self.qx[y * (self.w + 1) + x];
            *q += alpha * (target - *q);
        }
    }

    /// The same for an interior y face (between rows y - 1 and y of column x).
    pub fn nudge_flux_y(&mut self, x: usize, y: usize, target: f64, alpha: f64) {
        if self.method == Method::FiniteVolume || y == 0 || y >= self.h || x >= self.w { return; }
        let below = y * self.w + x;
        if self.depth[below] > 0.0 && self.depth[below - self.w] > 0.0 {
            let q = &mut self.qy[below];
            *q += alpha * (target - *q);
        }
    }

    /// The surface displacement at each tap now.
    pub fn sample(&self, taps: &[Tap]) -> Vec<f64> {
        taps.iter().map(|tap| tap.iter().map(|(i, w)| self.eta[*i] * w).sum()).collect()
    }

    /// Start recording eta at the given points, including the current state.
    pub fn record(&mut self, points: &[(f64, f64)]) -> Result<(), String> {
        if points.is_empty() || points.len() > 1024 { return Err("record between 1 and 1024 points".into()); }
        let taps = self.make_taps(points)?;
        let mut recorder = Recorder { points: taps.len(), taps, times: Vec::new(), values: Vec::new() };
        recorder.sample(self.time, &self.eta);
        self.recorder = Some(recorder);
        Ok(())
    }

    pub fn recorded(&self) -> Option<&Recorder> { self.recorder.as_ref() }

    pub fn advance(&mut self, steps: usize) -> Result<(), String> {
        if steps > 200 { return Err("advance at most 200 steps per call".into()); }
        let mut variable = false;
        if self.method == Method::Dispersive {
            let uniform = self.depth[0];
            variable = self.force_variable_dispersion || uniform <= 0.0 || self.depth.iter().any(|d| (*d-uniform).abs() > 1e-9);
            if variable {
                if self.variable.is_none() {
                    let mut v = crate::dispersion::Variable::new(self.w, self.h, self.cell, &self.depth);
                    v.tolerance = self.dispersion_tolerance;
                    self.variable = Some(v);
                }
            } else if self.filter.is_none() { self.filter = Some(crate::dispersion::Filter::new(self.w,self.h,uniform,self.cell)); }
        }
        for _ in 0..steps {
            if self.method == Method::FiniteVolume {
                self.finite_volume_step()?;
                self.sample_recorder()?;
                continue;
            }
            if variable { self.variable_momentum()?; } else {
                if self.method == Method::Dispersive { self.filter.as_mut().unwrap().solve(&self.eta)?; }
                let surface = if self.method == Method::Dispersive { &self.filter.as_ref().unwrap().surface } else { &self.eta };
                // Initial transport is zero at t=0: the first kick reaches dt/2.
                let kick = if self.steps == 0 { self.dt * 0.5 } else { self.dt } * G / self.cell;
                for y in 0..self.h { for x in 1..self.w {
                    let right = y * self.w + x;
                    let left = right - 1;
                    let face = y * (self.w + 1) + x;
                    if self.depth[left] > 0.0 && self.depth[right] > 0.0 {
                        let depth = (self.depth[left] + self.depth[right]) * 0.5;
                        self.qx[face] = (self.qx[face] - kick * depth * (surface[right] - surface[left]))
                            * self.damp_x[face];
                    }
                } }
                for y in 1..self.h { for x in 0..self.w {
                    let below = y * self.w + x;
                    let above = below - self.w;
                    if self.depth[above] > 0.0 && self.depth[below] > 0.0 {
                        let depth = (self.depth[above] + self.depth[below]) * 0.5;
                        self.qy[below] = (self.qy[below] - kick * depth * (surface[below] - surface[above]))
                            * self.damp_y[below];
                    }
                } }
            }
            for y in 0..self.h { for x in 0..self.w {
                let i = y * self.w + x;
                if self.depth[i] == 0.0 { continue; }
                let div = self.qx[y * (self.w + 1) + x + 1] - self.qx[y * (self.w + 1) + x]
                    + self.qy[i + self.w] - self.qy[i];
                self.eta[i] = (self.eta[i] - self.dt / self.cell * div) * self.damping[i];
                if !self.eta[i].is_finite() { return Err("non-finite wave state; stop the simulation".into()); }
                self.peak[i] = self.peak[i].max(self.eta[i].abs());
            } }
            self.steps += 1;
            self.time += self.dt;
            self.sample_recorder()?;
        }
        Ok(())
    }

    // Leapfrog momentum update with the variable-depth Peregrine acceleration.
    fn variable_momentum(&mut self) -> Result<(), String> {
        let v = self.variable.as_mut().unwrap();
        v.solve(&self.eta, G)?;
        let kick = if self.steps == 0 { self.dt * 0.5 } else { self.dt };
        let nx = (self.w + 1) * self.h;
        for y in 0..self.h { for x in 1..self.w {
            let face = y * (self.w + 1) + x;
            let depth = v.depth_x(face);
            if depth > 0.0 {
                self.qx[face] = (self.qx[face] + kick * depth * v.accel[face])
                    * self.damp_x[face];
            }
        } }
        for y in 1..self.h { for x in 0..self.w {
            let below = y * self.w + x;
            let depth = v.depth_y(below);
            if depth > 0.0 {
                self.qy[below] = (self.qy[below] + kick * depth * v.accel[nx + below])
                    * self.damp_y[below];
            }
        } }
        Ok(())
    }

    fn sample_recorder(&mut self) -> Result<(), String> {
        if let Some(r) = self.recorder.as_mut() {
            if r.values.len() + r.points > MAX_RECORDED_VALUES { return Err("boundary recording is too long; shorten the run".into()); }
            r.sample(self.time, &self.eta);
        }
        Ok(())
    }

    /// Total momentum-solver iterations so far (variable-depth dispersion only).
    pub fn dispersion_iterations(&self) -> usize { self.variable.as_ref().map_or(0, |v| v.total_iterations) }

    pub fn volume(&self) -> f64 { self.eta.iter().sum::<f64>() * self.cell * self.cell }

    // Acoustic Riemann flux for the same linear equations. Momentum is
    // cell-centred here; variable H multiplies the pressure gradient, so a
    // constant free surface remains exactly at rest over uneven bathymetry.
    fn rhs(&self, eta: &[f64], mx: &[f64], my: &[f64]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
        let n = self.w * self.h;
        let (mut de, mut dx, mut dy) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        for y in 0..self.h { for x in 0..self.w {
            let i = y * self.w + x;
            if self.depth[i] == 0.0 { continue; }
            for (nx, ny) in [(-1_i32, 0_i32), (1, 0), (0, -1), (0, 1)] {
                let xx = x as i32 + nx;
                let yy = y as i32 + ny;
                let j = if xx >= 0 && yy >= 0 && xx < self.w as i32 && yy < self.h as i32 { Some(yy as usize * self.w + xx as usize) } else { None };
                let q = nx as f64 * mx[i] + ny as f64 * my[i];
                let (mass, surface) = match j.filter(|j| self.depth[*j] > 0.0) {
                    Some(j) => {
                        let c = (G * self.depth[i].max(self.depth[j])).sqrt();
                        let other = nx as f64 * mx[j] + ny as f64 * my[j];
                        (0.5 * (q + other) - 0.5 * c * (eta[j] - eta[i]),
                         0.5 * (eta[i] + eta[j]) - 0.5 * (other - q) / c)
                    }
                    None => (0.0, eta[i] + q / (G * self.depth[i]).sqrt()),
                };
                de[i] -= mass / self.cell;
                dx[i] -= G * self.depth[i] * nx as f64 * surface / self.cell;
                dy[i] -= G * self.depth[i] * ny as f64 * surface / self.cell;
            }
        } }
        (de, dx, dy)
    }

    fn finite_volume_step(&mut self) -> Result<(), String> {
        // SSP-RK2 time integration. Spatial reconstruction is first order:
        // intentionally more diffusive than the staggered reference method.
        let (de, dx, dy) = self.rhs(&self.eta, &self.mx, &self.my);
        let e: Vec<f64> = self.eta.iter().zip(de).map(|(a, b)| a + self.dt * b).collect();
        let x: Vec<f64> = self.mx.iter().zip(dx).map(|(a, b)| a + self.dt * b).collect();
        let y: Vec<f64> = self.my.iter().zip(dy).map(|(a, b)| a + self.dt * b).collect();
        let (de, dx, dy) = self.rhs(&e, &x, &y);
        for i in 0..self.eta.len() {
            self.eta[i] = 0.5 * (self.eta[i] + e[i] + self.dt * de[i]) * self.damping[i];
            self.mx[i] = 0.5 * (self.mx[i] + x[i] + self.dt * dx[i]) * self.damping[i];
            self.my[i] = 0.5 * (self.my[i] + y[i] + self.dt * dy[i]) * self.damping[i];
            if !self.eta[i].is_finite() { return Err("non-finite finite-volume wave state".into()); }
            self.peak[i] = self.peak[i].max(self.eta[i].abs());
        }
        self.steps += 1;
        self.time += self.dt;
        Ok(())
    }
}

impl Recorder {
    fn sample(&mut self, time: f64, eta: &[f64]) {
        self.times.push(time);
        for tap in &self.taps { self.values.push(tap.iter().map(|(i, w)| eta[*i] * w).sum()); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cost of a step on a 160 x 96 coastal-sized grid (run with --ignored --nocapture).
    #[test]
    #[ignore]
    fn time_the_steps() {
        let (w, h) = (160usize, 96usize);
        let depth: Vec<f64> = (0..w * h).map(|i| { let x = (i % w) as f64; if x > 140.0 { 0.0 } else { (4000.0 - x * 18.0).max(30.0) } }).collect();
        let eta: Vec<f64> = (0..w * h).map(|i| if depth[i] > 0.0 { 1.5 * (-(((i % w) as f64 - 50.0).powi(2) + ((i / w) as f64 - 48.0).powi(2)) / 60.0).exp() } else { 0.0 }).collect();
        let sum = |v: &[f64]| v.iter().fold(0xcbf29ce484222325u64, |a, x| (a ^ x.to_bits()).wrapping_mul(0x100000001b3).rotate_left(5));
        for (name, method, absorbing) in [("staggered", Method::Staggered, true), ("staggered, no sponge", Method::Staggered, false), ("finite volume", Method::FiniteVolume, true), ("dispersive", Method::Dispersive, true)] {
            let mut s = Solver::new(w, h, 1500.0, depth.clone(), eta.clone(), absorbing).unwrap();
            s.method = method;
            let steps = if method == Method::Dispersive { 200 } else { 1000 };
            let t = std::time::Instant::now();
            for _ in 0..steps / 100 { s.advance(100).unwrap(); }
            let each = t.elapsed().as_secs_f64() / steps as f64;
            eprintln!("{name}: {:.1} us per step, {:.1} ns per cell-step; checksum eta {:016x} qx {:016x}; solver iterations per step {:.1}", each * 1e6, each * 1e9 / (w * h) as f64, sum(&s.eta), sum(&s.qx), s.dispersion_iterations() as f64 / s.steps as f64);
        }
    }


    #[test]
    fn still_water_stays_still_over_variable_bathymetry() {
        let depth: Vec<f64> = (0..800).map(|i| if i % 40 > 30 { 0.0 } else { 30.0 + (i % 40) as f64 * 100.0 }).collect();
        let mut s = Solver::new(40, 20, 1000.0, depth, vec![0.0; 800], true).unwrap();
        s.advance(200).unwrap();
        assert!(s.eta.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn wave_speed_matches_sqrt_gh() {
        // Gaussian at rest splits into two pulses moving at sqrt(g H).
        let (w, h) = (240, 8);
        let eta = (0..w*h).map(|i| (-0.5 * ((i % w) as f64 - 120.0).powi(2) / 64.0).exp()).collect();
        let mut s = Solver::new(w, h, 1000.0, vec![1000.0; w*h], eta, false).unwrap();
        s.advance(100).unwrap();
        let peak_x = (125..220).max_by(|a, b| s.eta[*a].total_cmp(&s.eta[*b])).unwrap();
        let expected = 120.0 + (G * 1000.0).sqrt() * s.time / s.cell;
        assert!((peak_x as f64 - expected).abs() < 1.5, "peak {peak_x}, expected {expected}");
        assert!((s.eta[peak_x] - 0.5).abs() < 0.02);
    }

    #[test]
    fn reflecting_basin_conserves_displacement_volume_and_dry_cells() {
        let (w, h) = (50, 40);
        let depth: Vec<f64> = (0..w*h).map(|i| if i % w > 40 { 0.0 } else { 500.0 }).collect();
        let eta = (0..w*h).map(|i| if i == 20 * w + 15 { 0.5 } else { 0.0 }).collect();
        let mut s = Solver::new(w, h, 1000.0, depth, eta, false).unwrap();
        let initial = s.volume();
        for _ in 0..10 { s.advance(100).unwrap(); }
        assert!((s.volume() - initial).abs() < 1e-6);
        assert!(s.eta.iter().zip(&s.depth).all(|(e, d)| e.is_finite() && (*d > 0.0 || *e == 0.0)));
    }

    #[test]
    fn outer_sponge_reduces_returning_wave_energy() {
        let mut sums = Vec::new();
        for absorbing in [false, true] {
            let eta = (0..80*60).map(|i| (-0.5 * (((i % 80) as f64 - 40.0).powi(2) + ((i / 80) as f64 - 30.0).powi(2)) / 25.0).exp()).collect();
            let mut s = Solver::new(80, 60, 1000.0, vec![1000.0; 4800], eta, absorbing).unwrap();
            for _ in 0..6 { s.advance(100).unwrap(); }
            sums.push(s.eta.iter().map(|v| v*v).sum::<f64>());
        }
        assert!(sums[1] < sums[0] * 0.15, "{sums:?}");
    }

    #[test]
    fn rejects_invalid_grids_and_step_budgets() {
        assert!(Solver::new(4, 4, 1.0, vec![0.0; 16], vec![0.0; 16], false).is_err());
        assert!(Solver::new(4, 4, f64::NAN, vec![100.0; 16], vec![0.0; 16], false).is_err());
        assert!(Solver::new(4, 4, 1.0, vec![100.0; 15], vec![0.0; 16], false).is_err());
        let mut s = Solver::new(4, 4, 1.0, vec![100.0; 16], vec![0.0; 16], false).unwrap();
        assert!(s.advance(201).is_err());
    }

    #[test]
    fn finite_volume_rest_and_mass_conservation() {
        let depth: Vec<f64> = (0..40*24).map(|i| if i % 40 > 32 { 0.0 } else { 500.0 + (i % 40) as f64 * 50.0 }).collect();
        let eta = depth.iter().map(|d| if *d > 0.0 { 0.1 } else { 0.0 }).collect();
        let mut s = Solver::new(40, 24, 1000.0, depth, eta, false).unwrap();
        s.method = Method::FiniteVolume;
        s.advance(100).unwrap();
        assert!(s.eta.iter().zip(&s.depth).all(|(e, d)| (*e - if *d > 0.0 { 0.1 } else { 0.0 }).abs() < 1e-12));
        s.eta[12 * 40 + 20] += 0.3;
        let volume = s.volume();
        s.advance(200).unwrap();
        assert!((s.volume() - volume).abs() < 1e-5);
    }

    #[test]
    fn finite_volume_wave_speed_and_damping_are_distinct() {
        let eta: Vec<f64> = (0..240*8).map(|i| (-0.5 * ((i % 240) as f64 - 120.0).powi(2) / 64.0).exp()).collect();
        let mut s = Solver::new(240, 8, 1000.0, vec![1000.0; 240*8], eta, false).unwrap();
        s.method = Method::FiniteVolume;
        s.advance(100).unwrap();
        let peak = (125..220).max_by(|a, b| s.eta[*a].total_cmp(&s.eta[*b])).unwrap();
        assert!((peak as f64 - 120.0 - (G * 1000.0).sqrt() * s.time / s.cell).abs() < 2.0);
        assert!(s.eta[peak] > 0.3 && s.eta[peak] < 0.49, "{}", s.eta[peak]);
    }
    #[test]
    fn dispersive_modes_follow_the_boussinesq_frequency_and_long_wave_limit() {
        // Neumann cosine eigenmodes: compare against the fully discrete
        // leapfrog dispersion relation, not a fitted animation arrival time.
        let (w,h,depth,cell) = (160,4,3000.0,1000.0);
        for mode in [1, 12] {
            let theta = mode as f64*std::f64::consts::PI/w as f64;
            let k = 2.0*(theta/2.0).sin()/cell;
            let omega = (G*depth*k*k/(1.0+depth*depth*k*k/3.0)).sqrt();
            let eta: Vec<f64> = (0..w*h).map(|i| 0.1*(theta*((i%w) as f64+0.5)).cos()).collect();
            let mut s = Solver::new(w,h,cell,vec![depth;w*h],eta.clone(),false).unwrap();
            s.method = Method::Dispersive;
            s.advance(80).unwrap();
            let discrete = 2.0*(omega*s.dt/2.0).asin()/s.dt;
            let expected = (discrete*s.time).cos();
            let projection = s.eta.iter().zip(&eta).map(|(e,a)|e*a).sum::<f64>()/eta.iter().map(|a|a*a).sum::<f64>();
            assert!((projection-expected).abs()<1e-7, "mode {mode}: {projection} vs {expected}");
            let ratio = omega/(G*depth).sqrt()/k;
            if mode == 1 { assert!((ratio-1.0).abs()<0.001); }
            else { assert!(ratio<0.93); }
            assert!(s.volume().abs()<1e-4);
        }
    }
    #[test]
    fn recorder_samples_wet_neighbours_and_rejects_land_and_outside_points() {
        let (w, h) = (20, 10);
        let depth: Vec<f64> = (0..w*h).map(|i| if i % w >= 10 { 0.0 } else { 100.0 }).collect();
        let eta: Vec<f64> = depth.iter().map(|d| if *d > 0.0 { 0.2 } else { 0.0 }).collect();
        let mut s = Solver::new(w, h, 1000.0, depth, eta, false).unwrap();
        // 9.9 lies between the last wet cell (centre 9.5) and land (10.5):
        // the land cell must not dilute the reading.
        s.record(&[(9.9, 5.0), (4.0, 4.0)]).unwrap();
        s.advance(10).unwrap();
        let r = s.recorded().unwrap();
        assert_eq!(r.times.len(), 11);
        assert_eq!(r.values.len(), 22);
        assert!(r.times.windows(2).all(|p| p[1] > p[0]));
        assert!((r.values[0] - 0.2).abs() < 1e-12 && (r.values[1] - 0.2).abs() < 1e-12);
        assert!(s.record(&[(15.0, 5.0)]).is_err());
        assert!(s.record(&[(0.2, 5.0)]).is_err());
        assert!(s.record(&[(5.0, f64::NAN)]).is_err());
        assert!(s.record(&[]).is_err());
    }

    #[test]
    fn dispersive_rest_over_uneven_bathymetry_and_land() {
        let (w, h) = (40, 20);
        let depth: Vec<f64> = (0..w*h).map(|i| if i % w > 34 { 0.0 } else { 100.0 + (i % w) as f64 * 90.0 }).collect();
        let mut s = Solver::new(w, h, 1000.0, depth, vec![0.0; w*h], false).unwrap();
        s.method = Method::Dispersive;
        s.advance(200).unwrap();
        assert!(s.eta.iter().all(|v| *v == 0.0));
    }

    fn shelf(w: usize, h: usize, deep: f64) -> Vec<f64> {
        // Deep ocean on the left, a sloping shelf, then land on the right.
        (0..w*h).map(|i| {
            let x = (i % w) as f64;
            if x >= w as f64 - 4.0 { 0.0 } else { (deep * ((w as f64 - 4.0 - x) / (w as f64 * 0.6)).min(1.0)).max(30.0) }
        }).collect()
    }
    fn pulse(w: usize, h: usize, x0: f64, sigma: f64) -> Vec<f64> {
        (0..w*h).map(|i| if i % w >= w - 4 { 0.0 } else { 0.5 * (-0.5 * (((i % w) as f64 - x0).powi(2) + ((i / w) as f64 - h as f64 / 2.0).powi(2)) / (sigma * sigma)).exp() }).collect()
    }

    #[test]
    fn variable_depth_operator_matches_the_uniform_solver_in_uniform_depth() {
        let (w, h) = (96, 40);
        let eta = pulse(w, h, 40.0, 3.0);
        let mut scalar = Solver::new(w, h, 1000.0, vec![3000.0; w*h], eta.clone(), false).unwrap();
        let mut variable = Solver::new(w, h, 1000.0, vec![3000.0; w*h], eta, false).unwrap();
        scalar.method = Method::Dispersive;
        variable.method = Method::Dispersive;
        variable.force_variable_dispersion = true;
        // Solved tightly, so this compares the two operators, not the solver's stopping point.
        variable.dispersion_tolerance = 1e-10;
        for _ in 0..3 { scalar.advance(40).unwrap(); variable.advance(40).unwrap(); }
        let worst = scalar.eta.iter().zip(&variable.eta).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        assert!(worst < 1e-7, "max difference {worst}");
    }

    #[test]
    fn the_default_solver_tolerance_changes_the_wave_by_far_less_than_a_millimetre() {
        // 1e-6 (the default) against 1e-10, a 0.5 m source over a shelf after 600 steps.
        let (w, h) = (96, 40);
        let depth = shelf(w, h, 3000.0);
        let eta = pulse(w, h, 40.0, 3.0);
        let run = |tolerance: f64| {
            let mut s = Solver::new(w, h, 1000.0, depth.clone(), eta.clone(), false).unwrap();
            s.method = Method::Dispersive;
            s.dispersion_tolerance = tolerance;
            for _ in 0..6 { s.advance(100).unwrap(); }
            (s.eta.clone(), s.dispersion_iterations())
        };
        let ((loose, loose_iterations), (tight, tight_iterations)) = (run(crate::dispersion::TOLERANCE), run(1e-10));
        let worst = loose.iter().zip(&tight).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
        assert!(worst < 1e-5, "max difference {worst} m");
        assert!(loose_iterations * 3 < tight_iterations * 2, "{loose_iterations} iterations against {tight_iterations}");
    }

    #[test]
    fn variable_depth_dispersion_conserves_displacement_volume_and_stays_bounded() {
        let (w, h) = (60, 20);
        let mut s = Solver::new(w, h, 1500.0, shelf(w, h, 4000.0), pulse(w, h, 20.0, 2.5), false).unwrap();
        s.method = Method::Dispersive;
        let initial = s.volume();
        for _ in 0..8 { s.advance(50).unwrap(); }
        assert!(s.eta.iter().all(|v| v.is_finite() && v.abs() < 1.0));
        assert!((s.volume() - initial).abs() < 1e-3 * initial.abs(), "{} vs {initial}", s.volume());
        assert!(s.eta.iter().zip(&s.depth).all(|(e, d)| *d > 0.0 || *e == 0.0));
    }

    #[test]
    fn variable_depth_dispersion_reduces_to_shallow_water_for_long_waves() {
        // A pulse 15 km wide on a 1000 m shelf (kH about 0.07) must travel like
        // the shallow-water wave, within the small cumulative dispersion.
        let (w, h) = (80, 8);
        let run = |method: Method| {
            let mut s = Solver::new(w, h, 1000.0, shelf(w, h, 1000.0), pulse(w, h, 15.0, 15.0), false).unwrap();
            s.method = method;
            while s.time < 1200.0 { s.advance(5).unwrap(); }
            s.eta[(h / 2) * w..(h / 2 + 1) * w].to_vec()
        };
        let (swe, dispersive) = (run(Method::Staggered), run(Method::Dispersive));
        let difference = (swe.iter().zip(&dispersive).map(|(p, q)| (p - q).powi(2)).sum::<f64>() / swe.iter().map(|p| p * p).sum::<f64>()).sqrt();
        assert!(difference < 0.08, "long pulse differs by {difference}");
    }

    #[test]
    fn variable_depth_dispersion_delays_and_reduces_short_waves() {
        // Over a gently shoaling bottom (4000 m to 2000 m), a pulse only a few
        // depths wide has lost speed and height to dispersion; the shallow-water
        // solver has not.
        let (w, h) = (120, 8);
        let depth: Vec<f64> = (0..w*h).map(|i| 4000.0 - 2000.0 * (((i % w) as f64 - 60.0) / 40.0).clamp(0.0, 1.0)).collect();
        let crest = |method: Method| {
            let eta = (0..w*h).map(|i| 0.5 * (-0.5 * (((i % w) as f64 - 30.0).powi(2) + ((i / w) as f64 - 4.0).powi(2)) / 16.0).exp()).collect();
            let mut s = Solver::new(w, h, 1000.0, depth.clone(), eta, false).unwrap();
            s.method = method;
            while s.time < 150.0 { s.advance(5).unwrap(); }
            let row = &s.eta[(h / 2) * w..(h / 2 + 1) * w];
            let at = (35..110).max_by(|a, b| row[*a].total_cmp(&row[*b])).unwrap();
            (at, row[at])
        };
        let (swe, dispersive) = (crest(Method::Staggered), crest(Method::Dispersive));
        assert!(dispersive.0 + 3 <= swe.0, "crest cells: shallow water {}, dispersive {}", swe.0, dispersive.0);
        assert!(dispersive.1 < 0.9 * swe.1, "crest height: shallow water {}, dispersive {}", swe.1, dispersive.1);
    }
}
