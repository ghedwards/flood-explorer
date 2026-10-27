//! Flash flooding from a storm on the model area (screening level).

use crate::hydro::Analysis;
use crate::surface::Run;
use crate::util::*;

/// Storm settings. NaN means "not given" (the JavaScript defaults apply).
#[derive(Clone, Debug)]
pub struct Storm {
    pub rain_mm: f64,
    pub hours: f64,
    pub initial_loss: f64,
    pub cont_loss: f64,
    pub n_channel: f64,
    pub n_overland: f64,
    pub max_rise: f64,
    pub max_pond_depth: f64,
    pub pipe_mm_h: f64,
    pub urban: Option<Vec<u8>>,
}

impl Default for Storm {
    fn default() -> Self {
        Storm {
            rain_mm: 0.0,
            hours: 1.0,
            initial_loss: f64::NAN,
            cont_loss: f64::NAN,
            n_channel: f64::NAN,
            n_overland: f64::NAN,
            max_rise: f64::NAN,
            max_pond_depth: f64::NAN,
            pipe_mm_h: 0.0,
            urban: None,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FlashSummary {
    pub excess_mm: f64,
    pub runoff_coeff: f64,
    pub creek_km2: f64,
    pub overland_km2: f64,
    pub pond_km2: f64,
    pub max_creek_rise: f64,
    pub piped_mm: f64,
    pub urban_km2: f64,
}

/// Rainfall uplift for a climate `warming_c` degrees warmer (draft ARR:
/// about 15%/°C for an hour's storm, 8%/°C for a day's, log-interpolated).
pub fn storm_uplift(hours: f64, warming_c: f64) -> f64 {
    if warming_c.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return 1.0;
    }
    let h = jmax(1.0, jmin(24.0, or(hours, 1.0)));
    let rate = 0.15 + (0.08 - 0.15) * (h.ln() / 24f64.ln());
    (1.0 + rate).powf(warming_c)
}

/// Creeks rise by the depth that carries their peak runoff (rational
/// method, Manning), spreading to connected low land; overland flow where
/// runoff is at least 10 cm deep; dips fill with the runoff draining in;
/// stormwater pipes take runoff from built-up land first.
pub fn flash_flood(a: &Analysis, o: &Storm) -> Run {
    let (w, h, n) = (a.w, a.h, a.n);
    let dem = &a.dem;
    let cell = a.cell;
    let rain = jmax(0.0, or(o.rain_mm, 0.0));
    let hours = jmax(0.1, or(o.hours, 1.0));
    let excess_mm = jmax(0.0, rain - nullish(o.initial_loss, 15.0) - nullish(o.cont_loss, 2.5) * hours);
    let cc = if rain > 0.0 { excess_mm / rain } else { 0.0 };
    let i_at = |akm2: f64| rain / jmax(hours, 0.76 * jmax(akm2, 1e-4).powf(0.38)) / 1000.0 / 3600.0;
    let cell_a = cell * cell;
    let n_ch = nullish(o.n_channel, 0.05);
    let n_ov = nullish(o.n_overland, 0.035);
    let max_rise = nullish(o.max_rise, 10.0);
    let (mut depth, mut kind, mut wet) = (vec![0f32; n], vec![0u8; n], vec![0u8; n]);
    let pipe = if o.urban.is_some() && o.pipe_mm_h > 0.0 { o.pipe_mm_h / 1000.0 / 3600.0 } else { 0.0 };
    let mut ua: Option<Vec<f32>> = None;
    let mut urban_cells = 0usize;
    if pipe > 0.0 {
        let urban = o.urban.as_ref().unwrap();
        let mut u = vec![0f32; n];
        for j in (0..a.n_order).rev() {
            let c = a.order[j] as usize;
            if urban[c] != 0 && a.valid[c] != 0 {
                u[c] += 1.0;
                urban_cells += 1;
            }
            if a.rec[c] >= 0 {
                let r = a.rec[c] as usize;
                u[r] = (u[r] as f64 + u[c] as f64) as f32;
            }
        }
        ua = Some(u);
    }
    let slope_at = |c: usize| -> f64 {
        let (mut d, mut k) = (c, 0);
        while k < 10 && a.rec[d] >= 0 {
            d = a.rec[d] as usize;
            k += 1;
        }
        let l = a.chain[c] - a.chain[d];
        jmax(0.002, if l > 0.0 { (dem[c] as f64 - dem[d] as f64) / l } else { 0.002 })
    };
    let mut rise = vec![0f32; n];
    if cc > 0.0 {
        for (c, cell_rise) in rise.iter_mut().enumerate() {
            if a.stream[c] == 0 || a.valid[c] == 0 || a.ocean[c] != 0 {
                continue;
            }
            let area = a.acc[c] * cell_a;
            let akm2 = area / 1e6;
            let q = cc * i_at(akm2) * area;
            let wd = jmax(cell, 20.0 * akm2.powf(0.4));
            *cell_rise = jmin(max_rise, ((q * n_ch) / (wd * slope_at(c).sqrt())).powf(0.6)) as f32;
        }
    }
    let mut level = vec![f32::NAN; n];
    let mut q = vec![0usize; n];
    let (mut qh, mut qt) = (0, 0);
    for c in 0..n {
        if a.valid[c] == 0 {
            continue;
        }
        if a.ocean[c] != 0 {
            wet[c] = 1;
            kind[c] = 4;
            continue;
        }
        let r = a.recv_stream[c];
        if r >= 0 && rise[r as usize] as f64 > 0.01 {
            level[c] = (dem[r as usize] as f64 + rise[r as usize] as f64) as f32;
        }
        if a.stream[c] != 0 && rise[c] as f64 > 0.01 {
            wet[c] = 1;
            kind[c] = 1;
            depth[c] = rise[c];
            q[qt] = c;
            qt += 1;
        }
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
            if wet[nn] != 0 || a.valid[nn] == 0 || dem[nn].partial_cmp(&level[nn]) != Some(std::cmp::Ordering::Less) {
                continue;
            }
            let r = a.recv_stream[nn];
            wet[nn] = 1;
            kind[nn] = 1;
            depth[nn] = jmin(level[nn] as f64 - dem[nn] as f64, (if r >= 0 { rise[r as usize] as f64 } else { 0.0 }) + 0.5) as f32;
            q[qt] = nn;
            qt += 1;
        }
    }
    let mut overland = 0usize;
    if cc > 0.0 {
        // Rain intensity depends only on the catchment area, and almost every land cell drains a
        // handful of cells, so it is worked out once per catchment size (a power per cell otherwise).
        let mut memo = vec![f64::NAN; 4096];
        let mut intensity = |acc: f64| -> f64 {
            if (0.0..4096.0).contains(&acc) && acc == acc.floor() {
                let k = acc as usize;
                if memo[k].is_nan() { memo[k] = i_at((acc * cell_a) / 1e6); }
                memo[k]
            } else {
                i_at((acc * cell_a) / 1e6)
            }
        };
        for c in 0..n {
            if a.valid[c] == 0 || a.stream[c] != 0 || a.ocean[c] != 0 || a.rec[c] < 0 {
                continue;
            }
            let r = a.rec[c] as usize;
            let piped = ua.as_ref().map_or(0.0, |u| pipe * u[c] as f64 * cell_a);
            let qw = jmax(0.0, cc * intensity(a.acc[c]) * a.acc[c] * cell_a - piped) / cell;
            let s = jmax(0.002, (dem[c] as f64 - dem[r] as f64) / jmax(cell, a.chain[c] - a.chain[r]));
            let x = (qw * n_ov) / s.sqrt();
            // x^0.6 reaches 0.1 m at x = 0.02154, so the power is only worked out for the few cells above 0.0215
            if x < 0.0215 {
                continue;
            }
            let d = x.powf(0.6);
            if d >= 0.1 && d > depth[c] as f64 {
                depth[c] = d as f32;
                kind[c] = 2;
                wet[c] = 1;
                overland += 1;
            }
        }
    }
    let mut pond_cells = 0usize;
    if let (Some(filled), true) = (a.filled.as_ref(), excess_mm > 0.0) {
        let mut lab = vec![-1i32; n];
        let mut groups: Vec<Vec<usize>> = Vec::new();
        let dip = |c: usize| filled[c] - dem[c] as f64 >= 0.02;
        for s0 in 0..n {
            if lab[s0] >= 0 || a.valid[s0] == 0 || a.ocean[s0] != 0 || !dip(s0) {
                continue;
            }
            let id = groups.len() as i32;
            let mut list = vec![s0];
            lab[s0] = id;
            let mut hd = 0;
            while hd < list.len() {
                let c = list[hd];
                hd += 1;
                let (cx, cy) = ((c % w) as i64, (c / w) as i64);
                for k in 0..4 {
                    let (nx, ny) = (cx + DX[k], cy + DY[k]);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let nn = ny as usize * w + nx as usize;
                    if lab[nn] >= 0 || a.valid[nn] == 0 || a.ocean[nn] != 0 || !dip(nn) {
                        continue;
                    }
                    lab[nn] = id;
                    list.push(nn);
                }
            }
            groups.push(list);
        }
        let ex = excess_mm / 1000.0;
        let max_pond = nullish(o.max_pond_depth, 5.0);
        for list in &groups {
            let (mut acc_max, mut c_max, mut lo, mut hi) = (0f64, list[0], f64::INFINITY, f64::NEG_INFINITY);
            for &c in list {
                if a.acc[c] > acc_max {
                    acc_max = a.acc[c];
                    c_max = c;
                }
                if (dem[c] as f64) < lo {
                    lo = dem[c] as f64;
                }
                if filled[c] > hi {
                    hi = filled[c];
                }
            }
            if hi - lo > max_pond {
                continue;
            }
            let vol = |l: f64| -> f64 {
                let mut v = 0.0;
                for &c in list {
                    if l > dem[c] as f64 {
                        v += jmin(l, filled[c]) - dem[c] as f64;
                    }
                }
                v * cell_a
            };
            let piped = ua.as_ref().map_or(0.0, |u| jmin(ex, pipe * hours * 3600.0) * u[c_max] as f64 * cell_a);
            let vin = ex * acc_max * cell_a - piped;
            if vin <= 0.0 {
                continue;
            }
            let mut l = hi;
            if vin < vol(hi) {
                let (mut a0, mut b0) = (lo, hi);
                for _ in 0..30 {
                    let m = (a0 + b0) / 2.0;
                    if vol(m) < vin {
                        a0 = m;
                    } else {
                        b0 = m;
                    }
                }
                l = (a0 + b0) / 2.0;
            }
            for &c in list {
                let d = jmin(l, filled[c]) - dem[c] as f64;
                if d > 0.02 && d > depth[c] as f64 {
                    depth[c] = d as f32;
                    kind[c] = 3;
                    wet[c] = 1;
                    pond_cells += 1;
                }
            }
        }
    }
    for c in 0..n {
        if wet[c] != 0 && a.ocean[c] == 0 {
            level[c] = (dem[c] as f64 + depth[c] as f64) as f32;
        }
    }
    let (mut creek, mut max_rise_seen) = (0usize, 0f64);
    for c in 0..n {
        if kind[c] == 1 {
            creek += 1;
        }
        if rise[c] as f64 > max_rise_seen {
            max_rise_seen = rise[c] as f64;
        }
    }
    let km2 = cell_a / 1e6;
    let summary = FlashSummary {
        excess_mm,
        runoff_coeff: cc,
        creek_km2: creek as f64 * km2,
        overland_km2: overland as f64 * km2,
        pond_km2: pond_cells as f64 * km2,
        max_creek_rise: max_rise_seen,
        piped_mm: if pipe > 0.0 { jmin(excess_mm, o.pipe_mm_h * hours) } else { 0.0 },
        urban_km2: urban_cells as f64 * km2,
    };
    Run {
        wet,
        depth,
        level,
        wse: rise.iter().map(|&v| v as f64).collect(),
        on_path: vec![0u8; n],
        kind: Some(kind),
        summary: Some(summary),
    }
}

#[cfg(test)]
mod skip_tests {
    /// `flash_flood` skips the overland-depth power for x below 0.0215, because x^0.6 is then under the 0.1 m
    /// that counts as overland flow. This keeps that cut-off safely on the low side.
    #[test]
    fn the_overland_cut_off_is_below_the_depth_that_counts() {
        assert!(0.0215_f64.powf(0.6) < 0.1);
        assert!(0.0216_f64.powf(0.6) > 0.0998, "and the cut-off is close enough to be worth having");
        assert!(0.0215 < 0.1_f64.powf(1.0 / 0.6));
    }
}
