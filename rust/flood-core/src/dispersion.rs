//! Uniform-depth linearised Boussinesq/Peregrine scalar Helmholtz solve.
//! (I - H²/3 Laplacian) phi = eta, q_t = -g H grad(phi).
//! Together with eta_t = -div(q), omega² = g H k²/(1+H² k²/3).
//! Neumann walls; no variable bathymetry, breaking or wet/dry coupling.
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
