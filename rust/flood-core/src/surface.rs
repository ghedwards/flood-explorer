//! The water surface along the river, connected inundation, statistics,
//! hazard classes and comparing runs.

use crate::hydro::Analysis;
use crate::util::*;

/// One scenario: gauge level, sea level, level points, gates, levees, or
/// a water surface supplied directly (flood over time).
#[derive(Clone, Debug, Default)]
pub struct Scenario {
    pub gauge: i32,
    pub gauge_level: f64,
    pub bay_level: f64,
    pub upstream_gradient: f64,
    /// extra level points: (cell, level)
    pub controls: Vec<(i64, f64)>,
    pub gates: Vec<i64>,
    pub levee: Option<Vec<u8>>,
    /// a water surface supplied by the caller (overrides the gauge)
    pub wse: Option<Vec<f64>>,
    /// use a backwater (gradually-varied) profile instead of a linear one
    pub backwater: bool,
}

/// A model run's result.
#[derive(Clone, Debug, Default)]
pub struct Run {
    pub wet: Vec<u8>,
    pub depth: Vec<f32>,
    pub level: Vec<f32>,
    pub wse: Vec<f64>,
    pub on_path: Vec<u8>,
    /// storm runs: 0 dry, 1 creek, 2 overland, 3 pond, 4 sea
    pub kind: Option<Vec<u8>>,
    pub summary: Option<crate::flash::FlashSummary>,
}

/// Water surface along the stream network (see the JavaScript model): the
/// gauge and level points fix the level, running linearly to the next point
/// downstream or the bay; other streams rise from where they join at the
/// upstream gradient; gates and levee crests stop backwater.
pub fn stream_surface(a: &Analysis, s: &Scenario) -> (Vec<f64>, Vec<u8>) {
    let n = a.n;
    let mut ctrl: Vec<(usize, f64)> = Vec::new();
    if s.gauge >= 0 {
        ctrl.push((s.gauge as usize, s.gauge_level));
    }
    for &(c, l) in &s.controls {
        if c >= 0 && (c as usize) < n && l.is_finite() {
            ctrl.push((c as usize, l));
        }
    }
    let mut ctrl_level: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
    for &(c, l) in &ctrl {
        let cur = ctrl_level.get(&c).copied().unwrap_or(f64::NEG_INFINITY);
        ctrl_level.insert(c, jmax(cur, l));
    }
    // Backwater pre-pass: standard-step profile from bay to gauge, anchored
    // at both ends.
    let mut bw_stage: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
    if s.backwater && s.gauge >= 0 {
        let g = s.gauge as usize;
        let mut path = Vec::new();
        let mut c = g as i64;
        while c >= 0 { path.push(c as usize); c = a.rec[c as usize] as i64; }
        if path.len() >= 2 {
            let n_m = 0.035f64;
            let mut stages = vec![f64::NAN; path.len()];
            stages[path.len()-1] = s.bay_level;
            for i in (0..path.len()-1).rev() {
                let (c0, c1) = (path[i], path[i+1]);
                let dx = (a.chain[c0] - a.chain[c1]).abs().max(a.cell);
                let h0 = stages[i+1];
                let depth0 = (h0 - a.dem[c1] as f64).max(0.1);
                let sf = (n_m*n_m) / depth0.powf(4.0/3.0);
                stages[i] = h0 + sf * dx;
            }
            // anchor: shift so upstream end = gauge level
            let err = s.gauge_level - stages[0];
            for (i, s) in stages.iter_mut().enumerate() {
                if s.is_finite() { *s += err * (1.0 - i as f64 / (path.len()-1) as f64); }
            }
            for (i, &cell) in path.iter().enumerate() {
                if stages[i].is_finite() { bw_stage.insert(cell, stages[i]); }
            }
        }
    }
    let mut on_path = vec![0u8; n];
    let mut path_wse = vec![f64::NEG_INFINITY; n];
    for &(p0, _) in &ctrl {
        let l0 = ctrl_level[&p0];
        let mut q = a.rec[p0];
        let mut end: i64 = -1;
        while q >= 0 {
            if ctrl_level.contains_key(&(q as usize)) {
                end = q as i64;
                break;
            }
            q = a.rec[q as usize];
        }
        let cu = a.chain[p0];
        let cd = if end >= 0 { a.chain[end as usize] } else { 0.0 };
        let ld = if end >= 0 { ctrl_level[&(end as usize)] } else { s.bay_level };
        let mut c = p0 as i64;
        while c >= 0 && c != end {
            let cc = c as usize;
            let t = if cu > cd { (a.chain[cc] - cd) / (cu - cd) } else { 1.0 };
            let t = t.clamp(0.0, 1.0);
            let v = if s.backwater {
                if let Some(&bs) = bw_stage.get(&cc) { bs } else { ld + (l0 - ld) * t.powf(1.3) }
            } else {
                ld + (l0 - ld) * t
            };
            if v > path_wse[cc] {
                path_wse[cc] = v;
            }
            on_path[cc] = 1;
            c = a.rec[cc] as i64;
        }
        if end >= 0 {
            on_path[end as usize] = 1;
        }
    }
    for (&c, &v) in &ctrl_level {
        if v > path_wse[c] {
            path_wse[c] = v;
        }
    }
    let grad = s.upstream_gradient / 1000.0;
    let mut gate = vec![0u8; n];
    for &c in &s.gates {
        if c >= 0 && (c as usize) < n {
            gate[c as usize] = 1;
        }
    }
    let mut junc = vec![-1i64; n];
    let mut wse = vec![f64::NAN; n];
    let lev = s.levee.as_deref();
    let mut crest = vec![f64::NEG_INFINITY; n];
    for j in 0..a.n_order {
        let c = a.order[j] as usize;
        if a.stream[c] == 0 {
            continue;
        }
        if on_path[c] != 0 {
            junc[c] = c as i64;
            wse[c] = path_wse[c];
            continue;
        }
        let r = a.rec[c];
        junc[c] = if gate[c] != 0 {
            -2
        } else if r >= 0 && a.stream[r as usize] != 0 {
            junc[r as usize]
        } else {
            -1
        };
        if junc[c] >= 0 {
            if let Some(lev) = lev {
                let r = r as usize;
                let here = if lev[r] != 0 || lev[c] != 0 { a.dem[if lev[c] != 0 { c } else { r }] as f64 } else { f64::NEG_INFINITY };
                crest[c] = jmax(crest[r], here);
                if crest[c] > wse[junc[c] as usize] {
                    junc[c] = -2;
                }
            }
        }
        wse[c] = if junc[c] == -2 {
            a.dem[c] as f64
        } else if junc[c] >= 0 {
            let jc = junc[c] as usize;
            wse[jc] + grad * (a.chain[c] - a.chain[jc])
        } else {
            s.bay_level + grad * a.chain[c]
        };
    }
    (wse, on_path)
}

/// Connected inundation for one scenario: a cell floods when it is below
/// the water surface of the stream it drains to and touches water through
/// 4-connected wet cells; water past a levee carries its level behind it.
pub fn inundate(a: &Analysis, s: &Scenario) -> Run {
    let n = a.n;
    let (wse, on_path) = match &s.wse {
        Some(v) => (v.clone(), vec![0u8; n]),
        None => stream_surface(a, s),
    };
    inundate_with(a, s, wse, on_path)
}

pub(crate) fn inundate_with(a: &Analysis, s: &Scenario, wse: Vec<f64>, on_path: Vec<u8>) -> Run {
    let (w, h, n) = (a.w, a.h, a.n);
    let mut level = vec![f32::NAN; n];
    for c in 0..n {
        if a.valid[c] == 0 {
            continue;
        }
        level[c] = if a.recv_stream[c] >= 0 { wse[a.recv_stream[c] as usize] as f32 } else { s.bay_level as f32 };
    }
    let mut wet = vec![0u8; n];
    let mut q = vec![0usize; n];
    let (mut qh, mut qt) = (0, 0);
    for c in 0..n {
        if a.valid[c] == 0 {
            continue;
        }
        if (a.ocean[c] != 0 || a.stream[c] != 0) && a.dem[c] < level[c] {
            wet[c] = 1;
            q[qt] = c;
            qt += 1;
        }
    }
    let lev = s.levee.as_deref();
    let mut carried = if lev.is_some() { vec![0u8; n] } else { Vec::new() };
    // Volume budget for water carried past levees: broad-crested weir
    // discharge over a 24 h duration, summed over overtopped levee cells.
    let cell_area = a.cell * a.cell;
    let mut budget = f64::INFINITY;
    let mut spent = 0.0f64;
    if let Some(lev) = lev {
        let cd = 0.6f64;
        let g = 9.81f64;
        let t = 24.0 * 3600.0;
        let mut b = 0.0f64;
        for c in 0..n {
            if lev[c] == 0 { continue; }
            let stage = if level[c].is_finite() { level[c] as f64 } else { 0.0 };
            let crest = a.dem[c] as f64;
            let do_ = stage - crest;
            if do_ > 0.0 {
                let q = cd * (2.0/3.0) * (2.0*g).sqrt() * a.cell * do_.powf(1.5);
                b += q * t;
            }
        }
        if b > 0.0 { budget = b; }
    }
    while qh < qt {
        let c = q[qh];
        qh += 1;
        let (cx, cy) = ((c % w) as i64, (c / w) as i64);
        for k in 0..4 {
            let (nx, ny) = (cx + DX[k], cy + DY[k]);
            if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                continue;
            }
            let nn = ny as usize * w + nx as usize;
            if wet[nn] != 0 || a.valid[nn] == 0 {
                continue;
            }
            let mut l = level[nn];
            let mut carry = false;
            if let Some(lev) = lev {
                if (lev[nn] != 0 || carried[c] != 0) && level[c] > l {
                    let vol = (level[c] as f64 - l as f64) * cell_area;
                    if spent + vol <= budget {
                        l = level[c];
                        carry = true;
                    }
                }
            }
            if a.dem[nn] < l {
                wet[nn] = 1;
                if carry {
                    level[nn] = l;
                    carried[nn] = 1;
                    spent += (l as f64 - a.dem[nn] as f64) * cell_area;
                }
                q[qt] = nn;
                qt += 1;
            }
        }
    }
    let mut depth = vec![0f32; n];
    for c in 0..n {
        if wet[c] != 0 {
            depth[c] = (level[c] as f64 - a.dem[c] as f64) as f32;
        }
    }
    Run { wet, depth, level, wse, on_path, kind: None, summary: None }
}

/// Area statistics against a baseline run.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub wet_land_km2: f64,
    pub flooded_km2: f64,
    pub deep_km2: f64,
    pub max_depth: f64,
    pub raw_max_depth: f64,
    pub mean_depth: f64,
}

pub fn stats(a: &Analysis, run: &Run, base: Option<&Run>) -> Stats {
    let cell_km2 = (a.cell * a.cell) / 1e6;
    let (mut land, mut extra, mut raw_max, mut sum_d, mut deep) = (0usize, 0usize, 0f64, 0f64, 0usize);
    let mut off: Vec<f64> = Vec::new();
    for c in 0..a.n {
        if run.wet[c] == 0 || a.ocean[c] != 0 {
            continue;
        }
        land += 1;
        if base.is_some_and(|b| b.wet[c] != 0) {
            continue;
        }
        extra += 1;
        let d = run.depth[c] as f64;
        sum_d += d;
        if d > raw_max {
            raw_max = d;
        }
        if d >= 1.0 {
            deep += 1;
        }
        if a.stream[c] == 0 {
            off.push(d);
        }
    }
    let mut p99 = 0.0;
    if !off.is_empty() {
        off.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        let i = ((off.len() as f64 * 0.99).floor() as usize).min(off.len() - 1);
        p99 = off[i];
    }
    Stats {
        wet_land_km2: land as f64 * cell_km2,
        flooded_km2: extra as f64 * cell_km2,
        deep_km2: deep as f64 * cell_km2,
        max_depth: p99,
        raw_max_depth: raw_max,
        mean_depth: if extra > 0 { sum_d / extra as f64 } else { 0.0 },
    }
}

/// Combine two runs, keeping the deeper water in each cell.
pub fn merge_runs(r1: &Run, r2: &Run) -> Run {
    let n = r1.wet.len();
    let (mut wet, mut depth, mut level) = (vec![0u8; n], vec![0f32; n], vec![f32::NAN; n]);
    for c in 0..n {
        let a = if r1.wet[c] != 0 { r1.depth[c] as f64 } else { -1.0 };
        let b = if r2.wet[c] != 0 { r2.depth[c] as f64 } else { -1.0 };
        if a < 0.0 && b < 0.0 {
            continue;
        }
        wet[c] = 1;
        if a >= b {
            depth[c] = a as f32;
            level[c] = r1.level[c];
        } else {
            depth[c] = b as f32;
            level[c] = r2.level[c];
        }
    }
    Run { wet, depth, level, wse: r1.wse.clone(), on_path: r1.on_path.clone(), kind: r2.kind.clone(), summary: r2.summary.clone() }
}

/// Flood hazard classes H1..H6 (Australian Disaster Resilience Guideline 7-3).
const HAZARD_LIMITS: [[f64; 3]; 5] = [[0.3, 2.0, 0.3], [0.5, 2.0, 0.6], [1.2, 2.0, 0.6], [2.0, 2.0, 1.0], [4.0, 4.0, 4.0]];

pub fn hazard_class(d: f64, v: f64) -> u8 {
    for (k, lim) in HAZARD_LIMITS.iter().enumerate() {
        if d <= lim[0] && v <= lim[1] && d * v <= lim[2] {
            return k as u8 + 1;
        }
    }
    6
}

/// Hazard for a run: class (0 dry, 1-6), estimated speed and km² per class.
pub struct Hazard {
    pub cls: Vec<u8>,
    pub vel: Vec<f32>,
    pub km2: [f64; 6],
}

pub fn hazard(a: &Analysis, run: &Run) -> Hazard {
    hazard_with_velocities(a, run, None, None)
}

pub fn hazard_with_velocities(a: &Analysis, run: &Run, vx: Option<&[f64]>, vy: Option<&[f64]>) -> Hazard {
    let n = a.n;
    let (mut cls, mut vel) = (vec![0u8; n], vec![0f32; n]);
    let level = &run.level;
    let mut slope = vec![0f32; n];
    let reach = jmax(2.0, js_round(500.0 / a.cell)) as usize;
    for c in 0..n {
        if a.stream[c] == 0 || run.wet[c] == 0 {
            continue;
        }
        let (mut d, mut k) = (c, 0);
        while k < reach && a.rec[d] >= 0 {
            d = a.rec[d] as usize;
            k += 1;
        }
        let l = a.chain[c] - a.chain[d];
        let lc = if (level[c] as f64).is_finite() { level[c] as f64 } else { a.dem[c] as f64 + run.depth[c] as f64 };
        let ld = if (level[d] as f64).is_finite() && run.wet[d] != 0 { level[d] as f64 } else { lc };
        slope[c] = (if l > 0.0 { jmax(0.0, (lc - ld) / l) } else { 0.0 }) as f32;
    }
    let mut km2 = [0f64; 6];
    let cell_km2 = (a.cell * a.cell) / 1e6;
    for c in 0..n {
        if run.wet[c] == 0 || a.ocean[c] != 0 {
            continue;
        }
        let d = run.depth[c] as f64;
        if d.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            continue;
        }
        let v = match (vx, vy) {
            (Some(vx), Some(vy)) if c < vx.len() && c < vy.len() => {
                (vx[c]*vx[c] + vy[c]*vy[c]).sqrt()
            }
            _ => {
                let kind = run.kind.as_ref().map_or(0, |k| k[c]);
                let (mut s, mut nn, mut cap) = (0f64, 0.06, 4.0);
                if kind == 3 {
                    s = 0.0;
                } else if kind == 2 && a.rec[c] >= 0 {
                    let r = a.rec[c] as usize;
                    s = jmax(0.0, (a.dem[c] as f64 - a.dem[r] as f64) / jmax(a.cell, a.chain[c] - a.chain[r]));
                } else if a.stream[c] != 0 {
                    s = slope[c] as f64;
                    nn = 0.035;
                    cap = 6.0;
                } else if a.recv_stream[c] >= 0 {
                    s = slope[a.recv_stream[c] as usize] as f64;
                }
                jmin(cap, (d.powf(2.0 / 3.0) * jmin(s, 0.2).sqrt()) / nn)
            }
        };
        vel[c] = v as f32;
        cls[c] = hazard_class(d, v);
        km2[cls[c] as usize - 1] += cell_km2;
    }
    Hazard { cls, vel, km2 }
}

/// Cell-by-cell comparison of two runs.
pub struct Compare {
    /// 1 wet in both, 2 only now, 3 only in the pinned run
    pub diff: Vec<u8>,
    pub d_depth: Vec<f32>,
    pub both_km2: f64,
    pub only_now_km2: f64,
    pub only_pinned_km2: f64,
    pub deeper_km2: f64,
    pub shallower_km2: f64,
}

pub fn compare_runs(a: &Analysis, now: &Run, pinned: &Run) -> Compare {
    let n = a.n;
    let cell_km2 = (a.cell * a.cell) / 1e6;
    let (mut diff, mut d_depth) = (vec![0u8; n], vec![0f32; n]);
    let (mut both, mut only_now, mut only_pinned, mut deeper, mut shallower) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for c in 0..n {
        if a.ocean[c] != 0 {
            continue;
        }
        let (w1, w0) = (now.wet[c] != 0, pinned.wet[c] != 0);
        if w1 && w0 {
            diff[c] = 1;
            both += cell_km2;
            d_depth[c] = (now.depth[c] as f64 - pinned.depth[c] as f64) as f32;
            if d_depth[c] as f64 > 0.05 {
                deeper += cell_km2;
            } else if (d_depth[c] as f64) < -0.05 {
                shallower += cell_km2;
            }
        } else if w1 {
            diff[c] = 2;
            only_now += cell_km2;
        } else if w0 {
            diff[c] = 3;
            only_pinned += cell_km2;
        }
    }
    Compare { diff, d_depth, both_km2: both, only_now_km2: only_now, only_pinned_km2: only_pinned, deeper_km2: deeper, shallower_km2: shallower }
}
