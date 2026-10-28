//! Experimental local-inertial, staggered-grid flood solver.
//! Bates, Horritt & Fewtrell (2010), doi:10.1016/j.jhydrol.2010.03.027.
//! Unit-width face discharge, semi-implicit Manning friction, hydrostatic
//! face depth and conservative donor-volume limiting. No advective momentum.
use crate::surface::hazard_class;
use crate::Grid;

const G: f64 = 9.81;
const DRY: f64 = 1e-6;
/// Water shallower than this is not wet for the hazard class (the same 1 cm the page calls wet).
const HAZARD_MIN_DEPTH: f64 = 0.01;
/// The default length of one entry of a rain or inflow series: an hour.
pub const HOURLY: f64 = 3600.0;
/// The default depth at which a cell counts as flooded for its arrival time (10 cm, where flow is overland flow).
pub const ARRIVAL_DEPTH: f64 = 0.1;

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
    /// Seconds each entry of `rain_series` and `inflow_series` lasts (3600 for hourly series; shorter for
    /// a burst of rain or a dam-break hydrograph). NaN means hourly.
    pub series_step_s: f64,
    /// Depth (m) at which a cell counts as flooded for its arrival time. NaN means 0.1 m.
    pub arrival_depth: f64,
}
impl Options {
    fn step(&self) -> f64 { if self.series_step_s.is_finite() { self.series_step_s } else { HOURLY } }
    fn arrival_at(&self) -> f64 { if self.arrival_depth.is_finite() { self.arrival_depth } else { ARRIVAL_DEPTH } }
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
    /// The fastest flow each cell has had (m/s), from the face discharges, for cells holding at least 1 cm.
    pub peak_speed: Vec<f64>,
    /// The worst flood hazard class (1-6, AIDR 7-3; 0 for a cell that was never wet) each cell has had: the class of its depth and speed at each step.
    pub peak_class: Vec<u8>,
    /// Seconds from the start until the cell first held `arrival_depth`; -1 if it never did.
    pub arrival: Vec<f64>,
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
            && (opts.series_step_s.is_nan() || (1.0..=86400.0).contains(&opts.series_step_s))
            && (opts.arrival_depth.is_nan() || (opts.arrival_depth > 0.0 && opts.arrival_depth <= 100.0))
            && opts.roughness.is_finite() && (0.01..=1.0).contains(&opts.roughness)
            && opts.initial_depth.is_finite() && (0.0..=100.0).contains(&opts.initial_depth)
            && opts.inflow_m3_s.is_finite() && (0.0..=100000.0).contains(&opts.inflow_m3_s)
            && opts.inflow_series.as_ref().is_none_or(|s| s.iter().all(|v| v.is_finite() && (0.0..=100000.0).contains(v)))) {
            return Err("invalid duration, rainfall, series step, arrival depth, roughness, initial depth or inflow".into());
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
            outgoing: vec![0.0;n], scale: vec![1.0;n], vx: vec![0.0;n], vy: vec![0.0;n], peak: vec![0.0;n],
            peak_speed: vec![0.0;n], peak_class: vec![0;n], arrival: vec![-1.0;n] };
        s.peak.copy_from_slice(&s.depth);
        let threshold = s.opts.arrival_at();
        for i in 0..n { if s.active(i) && !s.opts.stages[i].is_finite() && s.depth[i] >= threshold { s.arrival[i] = 0.0; } }
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
        let arrival_depth = self.opts.arrival_at();
        for _ in 0..count.min(32) {
            if self.time >= self.opts.seconds { break; }
            if self.steps >= 200000 { return Err("step budget exceeded; shorten the run or use a coarser grid".into()); }
            let max_h = self.depth.iter().copied().fold(0.001, f64::max);
            let mut dt = (0.35*dx/(G*max_h).sqrt()).min(5.0).min(self.opts.seconds-self.time);
            // With a custom series step, steps stop at each series boundary so a short burst is applied exactly.
            if self.opts.series_step_s.is_finite() {
                let to_boundary = self.opts.series_step_s - self.time % self.opts.series_step_s;
                if to_boundary > 1e-9 && to_boundary < dt { dt = to_boundary; }
            }
            // Include positive sources before fluxes and in the available donor volume.
            for i in 0..n {
                if self.active(i) && !self.opts.stages[i].is_finite() {
                    let extra = {
                        let r = self.opts.rain_series.as_ref()
                            .and_then(|s| {
                                let idx = (self.time / self.opts.step()) as usize;
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
                        let idx = (self.time / self.opts.step()) as usize;
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
                if self.arrival[i] < 0.0 && self.depth[i] >= arrival_depth && !self.opts.stages[i].is_finite() && self.active(i) { self.arrival[i] = self.time + dt; }
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
                if self.depth[i] >= HAZARD_MIN_DEPTH && !self.opts.stages[i].is_finite() && self.active(i) {
                    let v = self.vx[i].hypot(self.vy[i]);
                    if v > self.peak_speed[i] { self.peak_speed[i] = v; }
                    let class = hazard_class(self.depth[i], v);
                    if class > self.peak_class[i] { self.peak_class[i] = class; }
                }
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
            seconds:100.0,rain_mm_h:0.0,roughness:0.03,initial_depth:0.0,inflow_cell:None,inflow_m3_s:0.0,inflow_series:None,rain_series:None,stages:vec![f64::NAN;w*h],series_step_s:f64::NAN,arrival_depth:f64::NAN
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
            seconds:7200.0,rain_mm_h:0.0,roughness:0.035,initial_depth:0.0,inflow_cell:None,inflow_m3_s:0.0,inflow_series:None,rain_series:Some(vec![60.0,0.0]),stages,series_step_s:f64::NAN,arrival_depth:f64::NAN
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
    #[test] fn a_series_step_makes_rain_and_inflow_series_sub_hourly() {
        // 36 mm/h for the first 10 minutes only: 6 mm, not the 36 mm an hourly step would put down
        let mut s=solver(10,10);s.opts.rain_series=Some(vec![36.0,0.0]);s.opts.series_step_s=600.0;s.opts.seconds=3600.0;
        finish(&mut s);assert!((s.source_volume-60.0).abs()<1e-6, "{}",s.source_volume);assert!(s.balance_error().abs()<1e-8);
        let mut hourly=solver(10,10);hourly.opts.rain_series=Some(vec![36.0,0.0]);hourly.opts.seconds=3600.0;
        finish(&mut hourly);assert!((hourly.source_volume-360.0).abs()<1e-6, "the default step is an hour: {}",hourly.source_volume);
        // an inflow of 0.2 m3/s for 10 minutes then nothing: 120 m3
        let mut f=solver(10,10);f.opts.inflow_series=Some(vec![0.2,0.0]);f.opts.inflow_cell=Some(55);f.opts.series_step_s=600.0;f.opts.seconds=1800.0;
        finish(&mut f);assert!((f.source_volume-120.0).abs()<1e-6, "{}",f.source_volume);
    }
    #[test] fn a_short_series_step_is_checked() {
        let s=solver(2,2);
        for bad in [0.0,-5.0,0.5,f64::INFINITY,1e6] { let mut o=s.opts.clone();o.series_step_s=bad;assert!(Solver::new(s.grid.clone(),o).is_err(),"{bad}"); }
        for bad in [0.0,-0.1,1000.0] { let mut o=s.opts.clone();o.arrival_depth=bad;assert!(Solver::new(s.grid.clone(),o).is_err(),"{bad}"); }
        let mut ok=s.opts.clone();ok.series_step_s=300.0;ok.arrival_depth=0.05;assert!(Solver::new(s.grid,ok).is_ok());
    }
    #[test] fn arrival_is_the_first_time_a_cell_holds_the_depth_and_never_for_cells_not_reached() {
        let (w,h)=(12,1);
        let mut s=Solver::new(Grid {w,h,cell:10.0,dem:(0..w).map(|i| (w-1-i) as f32*0.5).collect(),valid:Some((0..w).map(|i| if i==w-1 {0} else {1}).collect()),inflow:None,d8:None},Options {
            seconds:600.0,rain_mm_h:0.0,roughness:0.035,initial_depth:0.0,inflow_cell:Some(0),inflow_m3_s:1.0,inflow_series:None,rain_series:None,stages:vec![f64::NAN;w*h],series_step_s:f64::NAN,arrival_depth:0.02
        }).unwrap();
        finish(&mut s);
        // 1 m3/s into a 100 m2 cell is 1 cm a second, less what runs off down the slope: the source cell holds 2 cm within seconds
        assert!(s.arrival[0]>0.0 && s.arrival[0]<=10.0, "{}",s.arrival[0]);
        // the source cell leaks into the next one, which can hold the depth first; from there the front moves down the slope
        let reached:Vec<f64>=s.arrival[1..w-1].iter().copied().filter(|a| *a>=0.0).collect();
        assert!(reached.len()>=3 && reached.windows(2).all(|p| p[0]<=p[1]+1e-9), "later further down the slope: {reached:?}");
        assert_eq!(s.arrival[w-1],-1.0,"a no-data cell is never flooded");
        // a cell that starts wet enough arrives at time 0
        let mut o=s.opts.clone();o.initial_depth=0.5;o.inflow_m3_s=0.0;
        let t=Solver::new(Grid {w:3,h:1,cell:10.0,dem:vec![0.0;3],valid:None,inflow:None,d8:None},Options{stages:vec![f64::NAN;3],..o}).unwrap();
        assert!(t.arrival.iter().all(|a| *a==0.0));
    }
    #[test] fn peak_hazard_class_and_speed_follow_the_worst_moment() {
        // 3 m of water released at one end of a flat channel: the next cells see deep, fast flow
        let (w,h)=(8,1);
        let mut s=Solver::new(Grid {w,h,cell:10.0,dem:vec![0.0;w],valid:None,inflow:None,d8:None},Options {
            seconds:60.0,rain_mm_h:0.0,roughness:0.03,initial_depth:0.0,inflow_cell:None,inflow_m3_s:0.0,inflow_series:None,rain_series:None,stages:vec![f64::NAN;w],series_step_s:f64::NAN,arrival_depth:f64::NAN
        }).unwrap();
        s.depth[0]=3.0;s.peak[0]=3.0;finish(&mut s);
        assert!(s.peak_speed[1]>1.0, "{}",s.peak_speed[1]);
        assert!(s.peak_class[1]>=4, "{}",s.peak_class[1]);
        assert!(s.peak_class.iter().zip(&s.depth).zip(s.vx.iter().zip(&s.vy)).all(|((c,d),(vx,vy))| *d<0.01 || *c>=hazard_class(*d,vx.hypot(*vy))), "the peak class is never below the final class");
        assert!(s.peak_class[w-1]<=s.peak_class[1], "the far end sees a milder worst case");
        let dry=solver(3,3); assert!(dry.peak_class.iter().all(|c| *c==0) && dry.peak_speed.iter().all(|v| *v==0.0));
    }
    #[test] fn rejects_bad_inputs() {
        let s=solver(2,2);let mut o=s.opts.clone();o.roughness=f64::NAN;
        assert!(Solver::new(s.grid,o).is_err());
    }
}
