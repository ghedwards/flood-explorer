//! Experimental nonlinear 2-D shallow-water equations with wetting/drying.
//! First-order Rusanov flux + Audusse et al. (2004) hydrostatic reconstruction.
//! Bed and initial water depth are separate: disconnected lakes keep their level.
//! Reflecting walls, optional relaxation sponge, semi-implicit Manning friction.
const G: f64 = 9.81;
const DRY: f64 = 1e-7;

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
}

impl Solver {
    #[allow(clippy::too_many_arguments)]
    pub fn new(w: usize, h: usize, cell: f64, bed: Vec<f64>, reference: Vec<f64>, eta: Vec<f64>, absorbing: bool, roughness: f64) -> Result<Self, String> {
        let n = w.checked_mul(h).ok_or("grid overflow")?;
        if !(4..=512).contains(&w) || !(4..=512).contains(&h) || !cell.is_finite() || cell < 1.0
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
            valid: vec![true; n], mx: vec![0.0; n], my: vec![0.0; n], sponge, roughness };
        s.dt = s.stable_dt();
        Ok(s)
    }

    pub fn set_valid(&mut self, mask: Vec<u8>) -> Result<(), String> {
        if mask.len() != self.water.len() || mask.iter().any(|v| *v > 1) || !mask.contains(&1)
            || mask.iter().enumerate().any(|(i, v)| *v == 0 && (self.water[i] != 0.0 || self.reference[i] != 0.0 || self.eta[i] != 0.0)) {
            return Err("invalid inundation mask; excluded cells must contain no water".into());
        }
        self.valid = mask.iter().map(|v| *v == 1).collect();
        Ok(())
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
                let (flux, cl, cr) = Self::face(left, right, zl, zr, axis);
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
    #[test]
    fn invalid_water_and_inputs_are_rejected() {
        assert!(Solver::new(4, 4, 25.0, vec![-1.0; 16], vec![1.0; 16], vec![-2.0; 16], false, 0.025).is_err());
        assert!(Solver::new(4, 4, 25.0, vec![f64::NAN; 16], vec![1.0; 16], vec![0.0; 16], false, 0.025).is_err());
    }
}
