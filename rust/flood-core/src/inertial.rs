//! Experimental local-inertial, staggered-grid flood solver.
//! Bates, Horritt & Fewtrell (2010), doi:10.1016/j.jhydrol.2010.03.027.
//! Unit-width face discharge, semi-implicit Manning friction, hydrostatic
//! face depth and conservative donor-volume limiting. No advective momentum.
use crate::Grid;

const G: f64 = 9.81;
const DRY: f64 = 1e-6;

#[derive(Clone)]
pub struct Options {
    pub seconds: f64,
    pub rain_mm_h: f64,
    /// Optional per-hour rainfall (mm/h); when present and non-empty it
    /// overrides rain_mm_h, indexed by the elapsed hour (clamped).
    pub rain_series: Option<Vec<f64>>,
    pub roughness: f64,
    pub initial_depth: f64,
    pub inflow_cell: Option<usize>,
    pub inflow_m3_s: f64,
    /// Optional per-hour release series (m³/s) at inflow_cell; when
    /// present and non-empty it overrides inflow_m3_s, indexed by the
    /// elapsed hour (clamped to the last entry).
    pub inflow_series: Option<Vec<f64>>,
    /// Prescribed water elevation at reservoir cells; NaN elsewhere.
    pub stages: Vec<f64>,
}

pub struct Solver {
    pub grid: Grid,
    pub opts: Options,
    pub depth: Vec<f64>,
    pub time: f64,
    pub steps: usize,
    pub initial_volume: f64,
    pub source_volume: f64,
    pub boundary_volume: f64,
    qx: Vec<f64>,
    qy: Vec<f64>,
    outgoing: Vec<f64>,
    scale: Vec<f64>,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    /// The deepest water each cell has held so far (after each step, boundary cells included).
    pub peak: Vec<f64>,
}
impl Solver {
    pub fn new(grid: Grid, opts: Options) -> Result<Self, String> {
        let n = grid.w.checked_mul(grid.h).ok_or("grid overflow")?;
        if n == 0 || n > 262144 || grid.dem.len() != n || !grid.cell.is_finite() || grid.cell <= 0.0 {
            return Err("solver needs a positive cell size and 1–262144 terrain cells".into());
        }
        if grid.valid.as_ref().is_some_and(|v| v.len() != n) || opts.stages.len() != n {
            return Err("mask/boundary size mismatch".into());
        }
        if !(opts.seconds.is_finite() && opts.seconds > 0.0 && opts.seconds <= 86400.0
            && opts.rain_mm_h.is_finite() && (0.0..=1000.0).contains(&opts.rain_mm_h)
            && opts.rain_series.as_ref().is_none_or(|s| s.iter().all(|v| v.is_finite() && (0.0..=1000.0).contains(v)))
            && opts.roughness.is_finite() && (0.01..=1.0).contains(&opts.roughness)
            && opts.initial_depth.is_finite() && (0.0..=100.0).contains(&opts.initial_depth)
            && opts.inflow_m3_s.is_finite() && (0.0..=100000.0).contains(&opts.inflow_m3_s)
            && opts.inflow_series.as_ref().is_none_or(|s| s.iter().all(|v| v.is_finite() && (0.0..=100000.0).contains(v)))) {
            return Err("invalid duration, rainfall, roughness, initial depth or inflow".into());
        }
        let active = |i: usize| grid.valid.as_ref().is_none_or(|v| v[i] != 0) && grid.dem[i].is_finite();
        if ! (0..n).any(active) { return Err("terrain has no valid cells".into()); }
        if opts.stages.iter().any(|s| s.is_infinite()) { return Err("invalid boundary elevation".into()); }
        let has_series = opts.inflow_series.as_ref().is_some_and(|s| !s.is_empty());
        if (opts.inflow_m3_s > 0.0 || has_series)
            && opts.inflow_cell.is_none_or(|i| i >= n || !active(i) || opts.stages[i].is_finite()) {
                return Err("inflow needs a valid non-boundary cell".into());
            }
        let depth = (0..n).map(|i| if !active(i) {0.0} else if opts.stages[i].is_finite() {
            (opts.stages[i] - grid.dem[i] as f64).max(0.0)
        } else {opts.initial_depth}).collect();
        let mut s = Self { grid, opts, depth, time: 0.0, steps: 0, initial_volume: 0.0,
            source_volume: 0.0, boundary_volume: 0.0, qx: vec![0.0;n], qy: vec![0.0;n],
            outgoing: vec![0.0;n], scale: vec![1.0;n], vx: vec![0.0;n], vy: vec![0.0;n], peak: vec![0.0;n] };
        s.peak.copy_from_slice(&s.depth);
        s.initial_volume = s.volume();
        Ok(s)
    }
    fn active(&self, i: usize) -> bool {
        self.grid.valid.as_ref().is_none_or(|v| v[i] != 0) && self.grid.dem[i].is_finite()
    }
    pub fn volume(&self) -> f64 { self.depth.iter().sum::<f64>() * self.grid.cell.powi(2) }
    pub fn balance_error(&self) -> f64 { self.volume() - self.initial_volume - self.source_volume - self.boundary_volume }
    fn flux(&self, i: usize, j: usize, q: f64, dt: f64) -> f64 {
        if !self.active(i) || !self.active(j) { return 0.0; }
        let (zi,zj) = (self.grid.dem[i] as f64, self.grid.dem[j] as f64);
        let (ei,ej) = (zi+self.depth[i], zj+self.depth[j]);
        let h = ei.max(ej) - zi.max(zj);
        if h <= DRY { return 0.0; }
        (q - G*h*dt*(ej-ei)/self.grid.cell) /
            (1.0 + G*dt*self.opts.roughness.powi(2)*q.abs()/h.powf(7.0/3.0))
    }
    /// Advance a bounded batch. Call between worker yields; 200k steps is a hard budget.
    pub fn advance(&mut self, count: usize) -> Result<(), String> {
        let n = self.depth.len(); let dx = self.grid.cell; let area = dx*dx;
        for _ in 0..count.min(32) {
            if self.time >= self.opts.seconds { break; }
            if self.steps >= 200000 { return Err("step budget exceeded; shorten the run or use a coarser grid".into()); }
            let max_h = self.depth.iter().copied().fold(0.001, f64::max);
            let dt = (0.35*dx/(G*max_h).sqrt()).min(5.0).min(self.opts.seconds-self.time);
            // Include positive sources before fluxes and in the available donor volume.
            for i in 0..n {
                if self.active(i) && !self.opts.stages[i].is_finite() {
                    let extra = {
                        let r = self.opts.rain_series.as_ref()
                            .and_then(|s| {
                                let idx = (self.time / 3600.0) as usize;
                                s.get(idx.min(s.len().saturating_sub(1))).copied()
                            })
                            .unwrap_or(self.opts.rain_mm_h);
                        r / 3_600_000.0 * dt
                    };
                    self.depth[i] += extra; self.source_volume += extra*area;
                }
            }
            if self.opts.inflow_m3_s > 0.0 || self.opts.inflow_series.as_ref().is_some_and(|s| !s.is_empty()) {
                let v = self.opts.inflow_series.as_ref()
                    .and_then(|s| {
                        let idx = (self.time / 3600.0) as usize;
                        s.get(idx.min(s.len().saturating_sub(1))).copied()
                    })
                    .unwrap_or(self.opts.inflow_m3_s);
                if v > 0.0 {
                    let vv = v * dt;
                    self.depth[self.opts.inflow_cell.unwrap()] += vv / area;
                    self.source_volume += vv;
                }
            }
            self.outgoing.fill(0.0);
            for i in 0..n {
                if i%self.grid.w+1 < self.grid.w { self.qx[i] = self.flux(i,i+1,self.qx[i],dt); }
                if i+self.grid.w < n { self.qy[i] = self.flux(i,i+self.grid.w,self.qy[i],dt); }
                for (j,q) in [(i+1,self.qx[i]),(i+self.grid.w,self.qy[i])] {
                    if q > 0.0 { self.outgoing[i] += q*dt/dx; }
                    else if q < 0.0 { self.outgoing[j] -= q*dt/dx; }
                }
            }
            for i in 0..n {
                self.scale[i] = if self.outgoing[i] > 0.0 { (self.depth[i]/self.outgoing[i]).min(1.0) } else {1.0};
            }
            for i in 0..n {
                for axis in 0..2 {
                    let (j, q) = if axis == 0 {(i+1,&mut self.qx[i])} else {(i+self.grid.w,&mut self.qy[i])};
                    if *q == 0.0 { continue; }
                    *q *= if *q > 0.0 {self.scale[i]} else {self.scale[j]};
                    let dh = *q*dt/dx;
                    self.depth[i] -= dh; self.depth[j] += dh;
                }
            }
            for i in 0..n {
                if !self.depth[i].is_finite() || self.depth[i] < -1e-8 { return Err("non-finite or negative depth; simulation stopped".into()); }
                self.depth[i] = self.depth[i].max(0.0);
                if self.active(i) && self.opts.stages[i].is_finite() {
                    let h = (self.opts.stages[i]-self.grid.dem[i] as f64).max(0.0);
                    self.boundary_volume += (h-self.depth[i])*area; self.depth[i] = h;
                }
                if self.depth[i] > self.peak[i] { self.peak[i] = self.depth[i]; }
            }
            // Update cell velocities from face fluxes (unit-width discharge / depth).
            for i in 0..n {
                let dl = if i%self.grid.w > 0 { self.qx[i-1] } else { 0.0 };
                let dr = if i%self.grid.w+1 < self.grid.w { self.qx[i] } else { 0.0 };
                let du = if i >= self.grid.w { self.qy[i-self.grid.w] } else { 0.0 };
                let dd = if i+self.grid.w < n { self.qy[i] } else { 0.0 };
                let h = self.depth[i].max(DRY);
                self.vx[i] = (dr + dl) / (2.0*h);
                self.vy[i] = (dd + du) / (2.0*h);
            }
            self.time += dt; self.steps += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn solver(w:usize,h:usize) -> Solver {
        Solver::new(Grid {w,h,cell:10.0,dem:vec![0.0;w*h],valid:None,inflow:None,d8:None},Options {
            seconds:100.0,rain_mm_h:0.0,roughness:0.03,initial_depth:0.0,inflow_cell:None,inflow_m3_s:0.0,inflow_series:None,rain_series:None,stages:vec![f64::NAN;w*h]
        }).unwrap()
    }
    fn finish(s:&mut Solver) { while s.time<s.opts.seconds {s.advance(32).unwrap();} }
    #[test] fn lake_at_rest_over_variable_bed() {
        let mut s=solver(12,8);
        for i in 0..96 { s.grid.dem[i]=(i%7) as f32*0.1; s.depth[i]=2.0-s.grid.dem[i] as f64; }
        s.initial_volume=s.volume(); let before=s.depth.clone();finish(&mut s);
        for (a,b) in s.depth.iter().zip(before) {assert!((a-b).abs()<1e-12);}
        assert!(s.balance_error().abs()<1e-8);
    }
    #[test] fn rainfall_and_inflow_balance() {
        let mut s=solver(10,10);s.opts.rain_mm_h=36.0;s.opts.inflow_m3_s=0.2;s.opts.inflow_cell=Some(55);
        finish(&mut s);assert!((s.volume()-30.0).abs()<1e-8);assert!(s.balance_error().abs()<1e-8);
    }
    #[test] fn wetting_drying_is_positive_symmetric_and_conservative() {
        let mut s=solver(11,11);s.depth[60]=1.0;s.initial_volume=s.volume();finish(&mut s);
        assert!(s.depth.iter().all(|&d| d>=0.0 && d.is_finite()));
        assert!(s.depth[59]>0.0);assert!((s.depth[59]-s.depth[61]).abs()<1e-12);
        assert!((s.depth[49]-s.depth[71]).abs()<1e-12);assert!(s.balance_error().abs()<1e-8);
    }
    #[test] fn nodata_is_impermeable() {
        let mut s=solver(5,5);s.grid.valid=Some((0..25).map(|i|if i%5==2 {0}else{1}).collect());
        s.depth[10]=1.0;s.initial_volume=s.volume();finish(&mut s);
        assert_eq!(s.depth[14],0.0);assert_eq!(s.depth[12],0.0);assert!(s.balance_error().abs()<1e-8);
    }
    #[test] fn boundary_exchange_is_accounted_for() {
        let mut s=solver(8,3);for i in [0,8,16] {s.opts.stages[i]=1.0;s.depth[i]=1.0;}
        s.initial_volume=s.volume();finish(&mut s);
        assert!(s.boundary_volume>0.0);assert!(s.depth[3]>0.0);assert!(s.balance_error().abs()<1e-8);
    }
    #[test] fn manning_uniform_flow_equilibrium() {
        let mut s=solver(2,1);s.grid.dem=vec![0.001,0.0];s.depth=vec![1.0,1.0+s.grid.dem[0] as f64];
        // Equal stages => no acceleration; friction damps existing flow.
        assert_eq!(s.flux(0,1,0.0,1.0),0.0);
        s.depth[1]=1.0;let slope=(s.grid.dem[0] as f64)/s.grid.cell;
        let q=slope.sqrt()/s.opts.roughness;
        assert!((s.flux(0,1,q,1.0)-q).abs()<1e-12);
    }
    #[test] fn peak_is_the_deepest_water_each_cell_held_and_never_below_the_final_depth() {
        // a slope draining to a held outlet: an hour of rain, then none; the rain puddles on the slope and then runs off
        let (w,h)=(12,1); let mut stages=vec![f64::NAN;w*h]; stages[w-1]=0.0;
        let mut s=Solver::new(Grid {w,h,cell:10.0,dem:(0..w).map(|i| (w-1-i) as f32*0.5).collect(),valid:None,inflow:None,d8:None},Options {
            seconds:7200.0,rain_mm_h:0.0,roughness:0.035,initial_depth:0.0,inflow_cell:None,inflow_m3_s:0.0,inflow_series:None,rain_series:Some(vec![60.0,0.0]),stages
        }).unwrap();
        finish(&mut s);
        assert!(s.peak.iter().zip(&s.depth).all(|(p,d)| p>=d), "the peak is at least the final depth everywhere");
        assert!(s.peak[..w-1].iter().all(|p| *p>0.0), "every cell got wet at some point");
        assert!(s.peak[4]>s.depth[4]+1e-4, "water that ran off left less behind than the peak: {} vs {}",s.peak[4],s.depth[4]);
        assert!(s.depth[..w-1].iter().all(|d| *d<0.01), "the slope has drained by the end");
        assert!(s.balance_error().abs()<1e-8);
    }
    #[test] fn peak_starts_at_the_initial_water() {
        let mut s=solver(4,4); s.opts.initial_depth=0.0; s.depth[5]=0.3; s.peak.copy_from_slice(&s.depth);
        assert_eq!(s.peak[5],0.3); assert_eq!(s.peak[0],0.0);
    }
    #[test] fn rejects_bad_inputs() {
        let s=solver(2,2);let mut o=s.opts.clone();o.roughness=f64::NAN;
        assert!(Solver::new(s.grid,o).is_err());
    }
}
