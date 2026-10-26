//! Linearised Boussinesq/Peregrine dispersion.
//!
//! `Filter`: uniform depth, scalar Helmholtz solve
//! (I - H²/3 Laplacian) phi = eta, q_t = -g H grad(phi).
//! Together with eta_t = -div(q), omega² = g H k²/(1+H² k²/3).
//!
//! `Variable`: variable depth with land walls. Solves the linearised Peregrine
//! momentum equation for w = u_t,
//!   w - (H/2) grad(div(H w)) + (H²/6) grad(div w) = -g grad(eta),
//! on the staggered grid. For uniform depth it reduces exactly (to solver
//! tolerance) to `Filter`. It is the weak-dispersion form, valid for kH
//! below about 1, and has no breaking or wet/dry coupling.
pub(crate) struct Filter {
    w: usize,
    h: usize,
    beta: f64,
    pub(crate) surface: Vec<f64>,
    r: Vec<f64>,
    p: Vec<f64>,
    ap: Vec<f64>,
}
impl Filter {
    pub(crate) fn new(w: usize, h: usize, depth: f64, cell: f64) -> Self {
        let n = w*h;
        Self { w, h, beta: depth*depth/(3.0*cell*cell), surface: vec![0.0; n], r: vec![0.0; n], p: vec![0.0; n], ap: vec![0.0; n] }
    }
    fn multiply(w: usize, h: usize, beta: f64, x: &[f64], out: &mut [f64]) {
        for y in 0..h { for col in 0..w {
            let i = y*w+col;
            let mut sum = 0.0;
            if col > 0 { sum += x[i] - x[i-1]; }
            if col+1 < w { sum += x[i] - x[i+1]; }
            if y > 0 { sum += x[i] - x[i-w]; }
            if y+1 < h { sum += x[i] - x[i+w]; }
            out[i] = x[i] + beta*sum;
        } }
    }
    pub(crate) fn solve(&mut self, eta: &[f64]) -> Result<(), String> {
        // Warm-started conjugate gradients on the symmetric positive-definite
        // Neumann Helmholtz operator. All work arrays are reused between steps.
        Self::multiply(self.w, self.h, self.beta, &self.surface, &mut self.ap);
        let norm = eta.iter().map(|e| e*e).sum::<f64>();
        let tolerance = 1e-18 * norm.max(1e-12);
        for (i, e) in eta.iter().enumerate() { self.r[i] = e - self.ap[i]; self.p[i] = self.r[i]; }
        let mut rr = self.r.iter().map(|v| v*v).sum::<f64>();
        for _ in 0..200 {
            if rr <= tolerance { return Ok(()); }
            Self::multiply(self.w, self.h, self.beta, &self.p, &mut self.ap);
            let denominator = self.p.iter().zip(&self.ap).map(|(p, a)| p*a).sum::<f64>();
            if !denominator.is_finite() || denominator <= 0.0 { return Err("dispersive pressure solve failed".into()); }
            let alpha = rr / denominator;
            for i in 0..eta.len() { self.surface[i] += alpha*self.p[i]; self.r[i] -= alpha*self.ap[i]; }
            let next = self.r.iter().map(|v| v*v).sum::<f64>();
            let beta = next/rr;
            for i in 0..eta.len() { self.p[i] = self.r[i] + beta*self.p[i]; }
            rr = next;
        }
        Err("dispersive pressure solve did not converge".into())
    }
}

/// Peregrine momentum solve on a staggered grid with variable depth. Unknowns
/// are the face accelerations w of every face between two wet cells; faces on
/// land or the domain boundary are fixed at zero.
pub(crate) struct Variable {
    w: usize,
    h: usize,
    inv_cell: f64,
    /// Depth at x faces ((w+1)*h) and y faces (w*(h+1)); zero for walls.
    hx: Vec<f64>,
    hy: Vec<f64>,
    nx: usize,
    /// Solution [x faces, y faces], warm-started between steps.
    pub(crate) accel: Vec<f64>,
    work: Vec<Vec<f64>>,
    div_h: Vec<f64>,
    div: Vec<f64>,
    inv_diag: Vec<f64>,
    previous: Vec<f64>,
    started: bool,
    pub(crate) iterations: usize,
    pub(crate) total_iterations: usize,
}

impl Variable {
    pub(crate) fn new(w: usize, h: usize, cell: f64, depth: &[f64]) -> Self {
        let mut hx = vec![0.0; (w + 1) * h];
        let mut hy = vec![0.0; w * (h + 1)];
        for y in 0..h { for x in 1..w {
            let (l, r) = (depth[y * w + x - 1], depth[y * w + x]);
            if l > 0.0 && r > 0.0 { hx[y * (w + 1) + x] = 0.5 * (l + r); }
        } }
        for y in 1..h { for x in 0..w {
            let (a, b) = (depth[(y - 1) * w + x], depth[y * w + x]);
            if a > 0.0 && b > 0.0 { hy[y * w + x] = 0.5 * (a + b); }
        } }
        let (nx, total) = (hx.len(), hx.len() + hy.len());
        // Jacobi preconditioner: each face couples to itself through
        // 1 + (2/3) H² / dx² (a-term +H²/dx², b-term -H²/(3 dx²)).
        let ic = 1.0 / cell;
        let inv_diag: Vec<f64> = hx.iter().chain(&hy).map(|d| 1.0 / (1.0 + 2.0 / 3.0 * d * d * ic * ic)).collect();
        Self { w, h, inv_cell: ic, hx, hy, nx, inv_diag, previous: vec![0.0; total], started: false, accel: vec![0.0; total], work: vec![vec![0.0; total]; 9],
            div_h: vec![0.0; w * h], div: vec![0.0; w * h], iterations: 0, total_iterations: 0 }
    }

    pub(crate) fn depth_x(&self, face: usize) -> f64 { self.hx[face] }
    pub(crate) fn depth_y(&self, face: usize) -> f64 { self.hy[face] }

    // out = L x on active faces; zero elsewhere.
    fn apply(&mut self, x: &[f64], out: &mut [f64]) {
        let (w, h, ic, nx) = (self.w, self.h, self.inv_cell, self.nx);
        for y in 0..h { for c in 0..w {
            let i = y * w + c;
            let (fl, fr) = (y * (w + 1) + c, y * (w + 1) + c + 1);
            let (ft, fb) = (nx + i, nx + i + w);
            self.div_h[i] = ((self.hx[fr] * x[fr] - self.hx[fl] * x[fl]) + (self.hy[i + w] * x[fb] - self.hy[i] * x[ft])) * ic;
            self.div[i] = ((x[fr] - x[fl]) + (x[fb] - x[ft])) * ic;
        } }
        for y in 0..h { for c in 1..w {
            let f = y * (w + 1) + c;
            let hf = self.hx[f];
            out[f] = if hf > 0.0 {
                let i = y * w + c;
                x[f] - 0.5 * hf * (self.div_h[i] - self.div_h[i - 1]) * ic + hf * hf / 6.0 * (self.div[i] - self.div[i - 1]) * ic
            } else { 0.0 };
        } }
        for y in 1..h { for c in 0..w {
            let i = y * w + c;
            let hf = self.hy[i];
            out[nx + i] = if hf > 0.0 {
                x[nx + i] - 0.5 * hf * (self.div_h[i] - self.div_h[i - w]) * ic + hf * hf / 6.0 * (self.div[i] - self.div[i - w]) * ic
            } else { 0.0 };
        } }
    }

    /// Solve L w = -g grad(eta) by warm-started BiCGSTAB.
    pub(crate) fn solve(&mut self, eta: &[f64], g: f64) -> Result<(), String> {
        let (w, h, nx) = (self.w, self.h, self.nx);
        let n = self.accel.len();
        let mut b = std::mem::take(&mut self.work[0]);
        b.iter_mut().for_each(|v| *v = 0.0);
        for y in 0..h { for c in 1..w {
            let f = y * (w + 1) + c;
            if self.hx[f] > 0.0 { b[f] = -g * (eta[y * w + c] - eta[y * w + c - 1]) * self.inv_cell; }
        } }
        for y in 1..h { for c in 0..w {
            let i = y * w + c;
            if self.hy[i] > 0.0 { b[nx + i] = -g * (eta[i] - eta[i - w]) * self.inv_cell; }
        } }
        let norm = b.iter().map(|v| v * v).sum::<f64>().sqrt();
        let result = if norm == 0.0 {
            self.accel.iter_mut().for_each(|v| *v = 0.0);
            self.started = false;
            Ok(())
        } else {
            // The acceleration varies smoothly in time: start from a linear
            // extrapolation of the last two solutions.
            if self.started { for i in 0..n { let last = self.accel[i]; self.accel[i] = 2.0 * last - self.previous[i]; self.previous[i] = last; } }
            else { self.previous.copy_from_slice(&self.accel); self.started = true; }
            self.bicgstab(&b, n, norm)
        };
        self.work[0] = b;
        result
    }

    // Right-preconditioned BiCGSTAB (van der Vorst) with the Jacobi scaling.
    fn bicgstab(&mut self, b: &[f64], n: usize, norm: f64) -> Result<(), String> {
        let mut x = std::mem::take(&mut self.accel);
        let [mut r, mut r0, mut p, mut v, mut s, mut t, mut ph, mut sh] = [1, 2, 3, 4, 5, 6, 7, 8].map(|k| std::mem::take(&mut self.work[k]));
        self.apply(&x, &mut v);
        for i in 0..n { r[i] = b[i] - v[i]; r0[i] = r[i]; p[i] = 0.0; v[i] = 0.0; }
        let dot = |a: &[f64], b: &[f64]| a.iter().zip(b).map(|(p, q)| p * q).sum::<f64>();
        let (mut rho, mut alpha, mut omega) = (1.0, 1.0, 1.0);
        let tolerance = TOLERANCE * norm;
        let mut outcome = Err("dispersive momentum solve did not converge".to_string());
        self.iterations = 0;
        for _ in 0..300 {
            self.iterations += 1; self.total_iterations += 1;
            if dot(&r, &r).sqrt() <= tolerance { outcome = Ok(()); break; }
            let rho_next = dot(&r0, &r);
            if !rho_next.is_finite() || rho_next == 0.0 { outcome = Err("dispersive momentum solve broke down".into()); break; }
            let beta = rho_next / rho * alpha / omega;
            for i in 0..n { p[i] = r[i] + beta * (p[i] - omega * v[i]); ph[i] = p[i] * self.inv_diag[i]; }
            rho = rho_next;
            self.apply(&ph, &mut v);
            let denominator = dot(&r0, &v);
            if !denominator.is_finite() || denominator == 0.0 { outcome = Err("dispersive momentum solve broke down".into()); break; }
            alpha = rho / denominator;
            for i in 0..n { s[i] = r[i] - alpha * v[i]; sh[i] = s[i] * self.inv_diag[i]; }
            if dot(&s, &s).sqrt() <= tolerance {
                for i in 0..n { x[i] += alpha * ph[i]; }
                outcome = Ok(()); break;
            }
            self.apply(&sh, &mut t);
            let tt = dot(&t, &t);
            if !tt.is_finite() || tt == 0.0 { outcome = Err("dispersive momentum solve broke down".into()); break; }
            omega = dot(&t, &s) / tt;
            for i in 0..n { x[i] += alpha * ph[i] + omega * sh[i]; r[i] = s[i] - omega * t[i]; }
        }
        for (k, vec) in [r, r0, p, v, s, t, ph, sh].into_iter().enumerate() { self.work[k + 1] = vec; }
        self.accel = x;
        outcome
    }
}

/// Relative residual at which the momentum solve stops. The solve is warm
/// started from the previous step; this is far below the scheme's own error.
const TOLERANCE: f64 = 1e-8;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn neumann_mode_has_the_analytical_discrete_transfer_function() {
        let (w,h) = (64,24);
        let mut f = Filter::new(w,h,2000.0,1000.0);
        let k = 5.0*std::f64::consts::PI/w as f64;
        let eta: Vec<f64> = (0..w*h).map(|i| (k*((i%w) as f64+0.5)).cos()).collect();
        f.solve(&eta).unwrap();
        let factor = 1.0/(1.0+4.0*f.beta*(k/2.0).sin().powi(2));
        assert!(f.surface.iter().zip(eta).all(|(actual, e)| (actual-e*factor).abs()<1e-9));
        f.solve(&vec![0.0; w*h]).unwrap();
        assert!(f.surface.iter().all(|v| v.abs()<1e-10));
    }
}
