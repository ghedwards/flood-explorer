//! Flood over time: the gauge's rise and fall (smooth or recorded), dam
//! releases, the wave travelling and flattening, routing below the gauge
//! (Muskingum-Cunge), recorded gauges along the river, tides and recorded
//! sea levels, and the hour-by-hour timeline.

use crate::hydro::Analysis;
use crate::surface::{inundate_with, stream_surface, Scenario};
use crate::util::*;

pub type Series = Vec<(f64, f64)>;

/// Options for flood over time. NaN means "not given".
#[derive(Clone, Debug)]
pub struct WaveOpts {
    pub base_level: f64,
    pub rise_hours: f64,
    pub fall_hours: f64,
    pub speed_kmh: f64,
    pub flatten: f64,
    pub route: bool,
    /// (amplitude m, low water at the peak)
    pub tide: Option<(f64, bool)>,
    /// (exponent b, depth of normal flow m)
    pub rating: Option<(f64, f64)>,
    /// (start hours, hours, fraction of the peak flow)
    pub release: Option<(f64, f64, f64)>,
    pub hydro: Option<Series>,
    pub sea: Option<Series>,
    /// other recorded gauges: (cell, readings)
    pub others: Vec<(i64, Series)>,
    pub step_hours: f64,
    pub max_steps: f64,
}

impl Default for WaveOpts {
    fn default() -> Self {
        WaveOpts {
            base_level: f64::NAN,
            rise_hours: f64::NAN,
            fall_hours: f64::NAN,
            speed_kmh: f64::NAN,
            flatten: f64::NAN,
            route: false,
            tide: None,
            rating: None,
            release: None,
            hydro: None,
            sea: None,
            others: Vec::new(),
            step_hours: f64::NAN,
            max_steps: f64::NAN,
        }
    }
}

fn interp(h: &Series, t: f64) -> f64 {
    if t <= h[0].0 {
        return h[0].1;
    }
    if t >= h[h.len() - 1].0 {
        return h[h.len() - 1].1;
    }
    let (mut i0, mut i1) = (0, h.len() - 1);
    while i1 - i0 > 1 {
        let m = (i0 + i1) >> 1;
        if h[m].0 <= t {
            i0 = m;
        } else {
            i1 = m;
        }
    }
    h[i0].1 + ((h[i1].1 - h[i0].1) * (t - h[i0].0)) / jmax(1e-9, h[i1].0 - h[i0].0)
}

#[derive(Clone, Debug)]
enum GaugeFn {
    Smooth { base: f64, peak: f64, rise: f64, fall: f64 },
    Recorded { rec: Series, shift: f64, t_end: f64 },
}

#[derive(Clone, Debug)]
struct ReleaseFn {
    zb: f64,
    span: f64,
    bx: f64,
    q_peak: f64,
    t0: f64,
    t1: f64,
    ramp: f64,
    frac: f64,
}

impl ReleaseFn {
    fn q_of(&self, h: f64) -> f64 {
        jmax(0.0, (h - self.zb) / self.span).powf(self.bx)
    }
    fn h_of(&self, q: f64) -> f64 {
        self.zb + self.span * jmax(0.0, q).powf(1.0 / self.bx)
    }
    fn rel(&self, t: f64) -> f64 {
        let r = if t <= self.t0 || t >= self.t1 { 0.0 } else { jmin(1.0, jmin((t - self.t0) / self.ramp, (self.t1 - t) / self.ramp)) };
        r * self.frac * self.q_peak
    }
}

#[derive(Clone, Debug)]
enum Band {
    Gauge,
    Smoothed { sm: Vec<f64>, t0: f64 },
}

#[derive(Clone, Debug)]
enum Bay {
    Fixed(f64),
    Tide { bay: f64, amp: f64, t_peak: f64, low: bool },
    Recorded(Series),
}

/// One reach node's routed flow.
#[derive(Clone, Debug)]
pub struct Flow {
    pub k: usize,
    pub q: Vec<f64>,
    pub r#ref: f64,
    pub kk: f64,
    pub x: f64,
}

#[derive(Clone, Debug)]
pub struct Routed {
    pub t0: f64,
    pub dt: f64,
    pub n_t: usize,
    pub flows: Vec<Flow>,
    pub cell_a: Vec<i32>,
    pub cell_f: Vec<f32>,
    zb: f64,
    span: f64,
    pub q_pk: f64,
    pub exponent: f64,
    pub rated: bool,
    /// (km below the gauge, K, X) for each reach
    pub reaches: Vec<(f64, f64, f64)>,
    pub tributaries: usize,
    pub extra_hours: f64,
}

impl Routed {
    pub fn h_of(&self, q: f64) -> f64 {
        self.zb + self.span * jmax(0.0, q).powf(1.0 / self.exponent)
    }
    /// The highest share of the reference flow at node n, and when.
    pub fn peak_at(&self, n: usize) -> (f64, f64) {
        let f = &self.flows[n];
        let (mut m, mut im) = (0.0, 0usize);
        for i in 0..self.n_t {
            if f.q[i] / f.r#ref > m {
                m = f.q[i] / f.r#ref;
                im = i;
            }
        }
        (m, self.t0 + im as f64 * self.dt)
    }
}

#[derive(Clone, Debug)]
enum Rel {
    Main,
    Recorded { h: Series, lo: f64, span2: f64 },
}

#[derive(Clone, Debug)]
pub struct Between {
    rel: Vec<Rel>,
    pub k1: Vec<i16>,
    pub k2: Vec<i16>,
    pub f: Vec<f32>,
    pub d1: Vec<f32>,
    pub d2: Vec<f32>,
    pub base: f64,
    pub rng: f64,
    pub gauges: usize,
    pub below: usize,
    /// which of opts.others were used, in order
    pub used: Vec<usize>,
}

/// A flood wave set up for a scenario.
#[derive(Clone, Debug)]
pub struct Wave {
    pub lo: f64,
    pub hi: f64,
    pub w0: Vec<f64>,
    pub w1: Vec<f64>,
    pub cells: Vec<i32>,
    pub arrive: Vec<f32>,
    pub min_a: f64,
    pub max_a: f64,
    pub rise: f64,
    pub fall: f64,
    gauge: GaugeFn,
    release: Option<ReleaseFn>,
    bands: Vec<Band>,
    pub band: Vec<u8>,
    pub t_start: f64,
    pub t_end: f64,
    pub t_peak: f64,
    pub routed: Option<Routed>,
    pub up: Option<Between>,
    /// (fraction, highest gauge level with it, rise it adds)
    pub release_info: Option<(f64, f64, f64)>,
    bay: Bay,
    pub tide: f64,
    pub sea_recorded: Option<(f64, f64)>,
}

impl Wave {
    fn base_gauge(&self, t: f64) -> f64 {
        match &self.gauge {
            GaugeFn::Smooth { base, peak, rise, fall } => {
                let pi = std::f64::consts::PI;
                if t <= 0.0 {
                    *base
                } else if t < *rise {
                    base + (peak - base) * 0.5 * (1.0 - ((pi * t) / rise).cos())
                } else if t < rise + fall {
                    base + (peak - base) * 0.5 * (1.0 + ((pi * (t - rise)) / fall).cos())
                } else {
                    *base
                }
            }
            GaugeFn::Recorded { rec, shift, t_end } => {
                if t <= rec[0].0 {
                    return rec[0].1 + shift;
                }
                if t >= *t_end {
                    return rec[rec.len() - 1].1 + shift;
                }
                let (mut lo2, mut hi2) = (0, rec.len() - 1);
                while hi2 - lo2 > 1 {
                    let m = (lo2 + hi2) >> 1;
                    if rec[m].0 <= t {
                        lo2 = m;
                    } else {
                        hi2 = m;
                    }
                }
                let (t0, v0) = rec[lo2];
                let (t1, v1) = rec[hi2];
                v0 + ((v1 - v0) * (t - t0)) / jmax(1e-9, t1 - t0) + shift
            }
        }
    }

    /// The level at the gauge at hour t (with any dam release).
    pub fn gauge_at(&self, t: f64) -> f64 {
        let g0 = self.base_gauge(t);
        match &self.release {
            Some(r) => {
                let x = r.rel(t);
                if x > 0.0 {
                    r.h_of(r.q_of(g0) + x)
                } else {
                    g0
                }
            }
            None => g0,
        }
    }

    /// The gauge's level as seen `b` bands of distance downstream (flattened).
    pub fn at(&self, b: usize, t: f64) -> f64 {
        match self.bands.get(b) {
            Some(Band::Smoothed { sm, t0 }) => {
                let n = sm.len();
                let x = jmin((n - 1) as f64, jmax(0.0, t - t0));
                let i0 = x.floor() as usize;
                let f = x - i0 as f64;
                sm[i0] + (sm[(n - 1).min(i0 + 1)] - sm[i0]) * f
            }
            _ => self.gauge_at(t),
        }
    }

    pub fn n_bands(&self) -> usize {
        self.bands.len()
    }

    /// The sea level at hour t.
    pub fn bay_at(&self, t: f64) -> f64 {
        match &self.bay {
            Bay::Fixed(b) => *b,
            Bay::Tide { bay, amp, t_peak, low } => {
                let off = if *low { 6.21 } else { 0.0 };
                bay - amp * (1.0 - ((2.0 * std::f64::consts::PI * (t - t_peak - off)) / 12.42).cos())
            }
            Bay::Recorded(sea) => interp(sea, t),
        }
    }

    fn rel(&self, k: usize, t: f64) -> f64 {
        let up = self.up.as_ref().unwrap();
        match &up.rel[k] {
            Rel::Main => (self.gauge_at(t) - up.base) / up.rng,
            Rel::Recorded { h, lo, span2 } => (interp(h, t) - lo) / span2,
        }
    }
}

/// Set up a flood wave for a scenario.
pub fn wave_setup(a: &Analysis, s: &Scenario, o: &WaveOpts) -> Wave {
    let rec = o.hydro.as_ref().filter(|h| h.len() > 1).cloned();
    let (mut rec_shift, mut rec_min) = (0.0, 0.0);
    if let Some(r) = &rec {
        let pk = js_max(r.iter().map(|x| x.1));
        rec_shift = s.gauge_level - pk;
        rec_min = js_min(r.iter().map(|x| x.1)) + rec_shift;
    }
    let base = if rec.is_some() { rec_min } else { o.base_level };
    let peak = s.gauge_level;
    let lo = jmin(base, peak - 0.5);
    let hi = jmax(peak, lo + 0.5);
    let sea = o.sea.as_ref().filter(|x| x.len() > 1).cloned();
    let sea_lo = sea.as_ref().map_or(0.0, |x| js_min(x.iter().map(|r| r.1)));
    let sea_hi = sea.as_ref().map_or(0.0, |x| js_max(x.iter().map(|r| r.1)));
    let amp = if sea.is_some() {
        jmax(0.01, (sea_hi - sea_lo) / 2.0)
    } else {
        match o.tide {
            Some((a_, _)) if a_ > 0.0 => a_,
            _ => 0.0,
        }
    };
    let mut s_low = s.clone();
    s_low.wse = None;
    if sea.is_some() {
        s_low.bay_level = sea_lo;
    } else if amp > 0.0 {
        s_low.bay_level = s.bay_level - 2.0 * amp;
    }
    let w0 = {
        let mut x = s_low.clone();
        x.gauge_level = lo;
        stream_surface(a, &x).0
    };
    let w1 = {
        let mut x = s_low.clone();
        x.gauge_level = hi;
        stream_surface(a, &x).0
    };
    let mut cells = Vec::new();
    for c in 0..a.n {
        if a.stream[c] != 0 && w0[c].is_finite() && w1[c].is_finite() {
            cells.push(c as i32);
        }
    }
    let g: i64 = if s.gauge >= 0 { s.gauge as i64 } else { a.main_outlet as i64 };
    let chain_g = if g >= 0 { a.chain[g as usize] } else { f64::NAN };
    let speed = jmax(0.1, or(o.speed_kmh, 3.0));
    let mut arrive = vec![0f32; a.n];
    let (mut min_a, mut max_a) = (0f64, 0f64);
    for &c in &cells {
        let hrs = (chain_g - a.chain[c as usize]) / 1000.0 / speed;
        arrive[c as usize] = hrs as f32;
        if hrs < min_a {
            min_a = hrs;
        }
        if hrs > max_a {
            max_a = hrs;
        }
    }
    let rise = jmax(0.5, or(o.rise_hours, 24.0));
    let fall = jmax(0.5, or(o.fall_hours, 48.0));
    let (gauge, mut t_start, mut t_end) = match &rec {
        Some(r) => {
            let t_end = r[r.len() - 1].0;
            (GaugeFn::Recorded { rec: r.clone(), shift: rec_shift, t_end }, r[0].0, t_end)
        }
        None => (GaugeFn::Smooth { base, peak, rise, fall }, 0.0, rise + fall),
    };
    let mut w = Wave {
        lo,
        hi,
        w0,
        w1,
        cells,
        arrive,
        min_a,
        max_a,
        rise,
        fall,
        gauge,
        release: None,
        bands: vec![Band::Gauge],
        band: vec![0u8; a.n],
        t_start,
        t_end,
        t_peak: 0.0,
        routed: None,
        up: None,
        release_info: None,
        bay: Bay::Fixed(s.bay_level),
        tide: amp,
        sea_recorded: None,
    };
    // a dam release upstream
    if let Some((start, hours, frac)) = o.release {
        if frac > 0.0 && hours > 0.0 {
            let rt = o.rating.filter(|&(b, d)| b > 0.5 && d > 0.0);
            let zb = match rt {
                Some((_, d)) => lo - jmax(0.1, d),
                None => jmin(a.dem[g as usize] as f64 - 1.0, lo - 0.5),
            };
            let bx = match rt {
                Some((b, _)) => jmin(4.0, jmax(0.8, b)),
                None => 5.0 / 3.0,
            };
            let span = hi - zb;
            let mut r = ReleaseFn { zb, span, bx, q_peak: 0.0, t0: start, t1: start + hours, ramp: jmin(3.0, hours / 2.0), frac };
            r.q_peak = r.q_of(peak);
            w.release = Some(r);
            t_start = jmin(t_start, start - 1.0);
            t_end = jmax(t_end, start + hours + 1.0);
            w.t_start = t_start;
            w.t_end = t_end;
            let mut top = f64::NEG_INFINITY;
            let mut t = t_start;
            while t <= t_end {
                top = jmax(top, w.gauge_at(t));
                t += 0.5;
            }
            w.release_info = Some((frac, top, top - peak));
        }
    }
    // the wave flattening as it travels downstream
    let flatten = jmax(0.0, or(o.flatten, 0.0));
    let band_km: [f64; 9] = [0.0, 1.0, 2.0, 5.0, 10.0, 20.0, 40.0, 80.0, 160.0];
    if flatten > 0.0 {
        let pad = (3.0 * flatten * band_km[band_km.len() - 1].sqrt()).ceil() + 2.0;
        let t0 = (t_start - pad).floor();
        let t1 = (t_end + pad).ceil();
        let n = (t1 - t0 + 1.0) as usize;
        let raw: Vec<f64> = (0..n).map(|i| w.gauge_at(t0 + i as f64)).collect();
        let mut bands = vec![Band::Gauge];
        for &km in &band_km[1..] {
            let sig = flatten * km.sqrt();
            let r = (3.0 * sig).ceil() as i64;
            let mut wts = Vec::new();
            let mut wsum = 0.0;
            for k in -r..=r {
                let wv = (-((k * k) as f64) / (2.0 * sig * sig)).exp();
                wts.push(wv);
                wsum += wv;
            }
            let mut sm = vec![0f64; n];
            for i in 0..n as i64 {
                let mut acc = 0.0;
                for k in -r..=r {
                    let j = (i + k).clamp(0, n as i64 - 1) as usize;
                    acc += wts[(k + r) as usize] * raw[j];
                }
                sm[i as usize] = acc / wsum;
            }
            bands.push(Band::Smoothed { sm, t0 });
        }
        w.bands = bands;
        for &c in &w.cells {
            let c = c as usize;
            if w.arrive[c] <= 0.0 {
                continue;
            }
            let km = w.arrive[c] as f64 * speed;
            let mut b = 0;
            for k in 1..band_km.len() {
                if (band_km[k] - km).abs() < (band_km[b] - km).abs() {
                    b = k;
                }
            }
            w.band[c] = b as u8;
        }
    }
    w.t_peak = match &rec {
        Some(r) => {
            let mut m = r[0];
            for &x in r.iter() {
                if x.1 > m.1 {
                    m = x;
                }
            }
            m.0
        }
        None => rise,
    };
    if o.route && g >= 0 {
        w.routed = route_down(a, &w, g as usize, speed, o.rating);
    }
    if rec.is_some() && !o.others.is_empty() && g >= 0 {
        w.up = between_gauges(a, &w, g as usize, speed, &o.others);
    }
    if let Some(r) = &w.routed {
        w.max_a = jmax(w.max_a, r.extra_hours);
    }
    w.bay = if let Some(sea) = sea.clone() {
        Bay::Recorded(sea)
    } else if amp > 0.0 {
        Bay::Tide { bay: s.bay_level, amp, t_peak: w.t_peak, low: o.tide.is_some_and(|t| t.1) }
    } else {
        Bay::Fixed(s.bay_level)
    };
    w.sea_recorded = if sea.is_some() { Some((sea_lo, sea_hi)) } else { None };
    w
}

fn between_gauges(a: &Analysis, w: &Wave, g: usize, speed_kmh: f64, others: &[(i64, Series)]) -> Option<Between> {
    let n = a.n;
    let cms = speed_kmh * 1000.0;
    let base = w.gauge_at(w.t_start);
    let pk = js_max((0..200).map(|i| w.gauge_at(w.t_start + ((w.t_end - w.t_start) * i as f64) / 199.0)));
    let rng = jmax(0.01, pk - base);
    let mut rel = vec![Rel::Main];
    let mut cells = vec![g];
    let mut used = Vec::new();
    for (idx, (cell, hyd)) in others.iter().enumerate() {
        let oc = *cell;
        if oc < 0 || oc as usize >= n || a.stream[oc as usize] == 0 || hyd.len() < 2 || cells.contains(&(oc as usize)) {
            continue;
        }
        let oc = oc as usize;
        let (mut c, mut k) = (oc as i64, 0usize);
        while c >= 0 && c as usize != g && k < n {
            c = a.rec[c as usize] as i64;
            k += 1;
        }
        if c != g as i64 {
            let mut below = false;
            let mut d = a.rec[g] as i64;
            while d >= 0 {
                if d as usize == oc {
                    below = true;
                    break;
                }
                d = a.rec[d as usize] as i64;
            }
            if !below {
                continue;
            }
        }
        let lo = js_min(hyd.iter().map(|r| r.1));
        let hi = js_max(hyd.iter().map(|r| r.1));
        rel.push(Rel::Recorded { h: hyd.clone(), lo, span2: jmax(0.01, hi - lo) });
        cells.push(oc);
        used.push(idx);
    }
    if cells.len() < 2 {
        return None;
    }
    let gi: std::collections::HashMap<usize, usize> = cells.iter().enumerate().map(|(k, &c)| (c, k)).collect();
    let mut below_main = std::collections::HashSet::new();
    let mut d = a.rec[g] as i64;
    while d >= 0 {
        if gi.contains_key(&(d as usize)) {
            below_main.insert(d as usize);
        }
        d = a.rec[d as usize] as i64;
    }
    let (mut k1, mut k2) = (vec![-1i16; n], vec![-1i16; n]);
    let (mut f, mut d1, mut d2) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
    let mut down = vec![0u8; n];
    for (k, &u) in cells.iter().enumerate() {
        let mut l = a.rec[u] as i64;
        while l >= 0 && !gi.contains_key(&(l as usize)) {
            l = a.rec[l as usize] as i64;
        }
        if l < 0 {
            continue;
        }
        let l = l as usize;
        let len = jmax(1.0, a.chain[u] - a.chain[l]);
        let mut is_down = u == g;
        let mut x = a.rec[g] as i64;
        while x >= 0 && !is_down {
            if x as usize == u {
                is_down = true;
            }
            x = a.rec[x as usize] as i64;
        }
        let mut c = u;
        while c != l {
            k1[c] = k as i16;
            k2[c] = gi[&l] as i16;
            f[c] = ((a.chain[u] - a.chain[c]) / len) as f32;
            d1[c] = ((a.chain[u] - a.chain[c]) / cms) as f32;
            d2[c] = ((a.chain[c] - a.chain[l]) / cms) as f32;
            if is_down {
                down[c] = 1;
            }
            c = a.rec[c] as usize;
        }
    }
    for (k, &c) in cells.iter().enumerate().skip(1) {
        if k1[c] < 0 {
            k1[c] = k as i16;
            k2[c] = -1;
            f[c] = 0.0;
            d1[c] = 0.0;
        }
    }
    let mut first = vec![-1i64; n];
    for j in 0..a.n_order {
        let c = a.order[j] as usize;
        first[c] = if gi.contains_key(&c) {
            c as i64
        } else if a.rec[c] >= 0 {
            first[a.rec[c] as usize]
        } else {
            -1
        };
        let fc = first[c];
        if fc >= 0 && fc as usize != g && k1[c] < 0 && a.stream[c] != 0 && down[fc as usize] == 0 && !below_main.contains(&(fc as usize)) {
            k1[c] = gi[&(fc as usize)] as i16;
            k2[c] = -1;
            f[c] = 0.0;
            d1[c] = (-(a.chain[c] - a.chain[fc as usize]) / cms) as f32;
        } else if k1[c] < 0 && a.stream[c] != 0 && a.rec[c] >= 0 && down[a.rec[c] as usize] != 0 {
            let r = a.rec[c] as usize;
            k1[c] = k1[r];
            k2[c] = k2[r];
            f[c] = f[r];
            d1[c] = d1[r];
            d2[c] = d2[r];
            down[c] = 1;
        }
    }
    Some(Between { rel, k1, k2, f, d1, d2, base, rng, gauges: cells.len() - 1, below: below_main.len(), used })
}

/// Time of concentration (hours) for a catchment of A km² (ARR).
fn tc_hours(akm2: f64) -> f64 {
    0.76 * jmax(akm2, 0.01).powf(0.38)
}

struct Inflow {
    area: f64,
    lag: f64,
    local: bool,
}

/// Route the gauge's flood down the river below it (Muskingum-Cunge).
fn route_down(a: &Analysis, w: &Wave, g: usize, speed_kmh: f64, rating: Option<(f64, f64)>) -> Option<Routed> {
    let n = a.n;
    let cell_km2 = (a.cell * a.cell) / 1e6;
    let ag = jmax(a.acc[g] * cell_km2, 0.01);
    let tcg = tc_hours(ag);
    let use_r = rating.filter(|&(b, d)| b > 0.5 && d > 0.0);
    let zb = match use_r {
        Some((_, d)) => w.lo - jmax(0.1, d),
        None => jmin(a.dem[g] as f64 - 1.0, w.lo - 0.5),
    };
    let bx = match use_r {
        Some((b, _)) => jmin(4.0, jmax(0.8, b)),
        None => 5.0 / 3.0,
    };
    let span = w.hi - zb;
    let q_of = |h: f64| jmax(0.0, (h - zb) / span).powf(bx);
    let mut path = Vec::new();
    let mut on_p = vec![-1i64; n];
    let mut c = g as i64;
    while c >= 0 {
        on_p[c as usize] = path.len() as i64;
        path.push(c as usize);
        c = a.rec[c as usize] as i64;
    }
    if path.len() < 3 {
        return None;
    }
    let mut entry = vec![-1i64; n];
    entry[g] = -2;
    for j in 0..a.n_order {
        let c = a.order[j] as usize;
        if c == g || on_p[c] >= 0 {
            continue;
        }
        let r = a.rec[c];
        if r < 0 {
            continue;
        }
        let r = r as usize;
        if r == g || entry[r] == -2 {
            entry[c] = -2;
            continue;
        }
        if a.stream[c] == 0 {
            continue;
        }
        if on_p[r] >= 0 {
            entry[c] = c as i64;
        } else if a.stream[r] != 0 && entry[r] >= 0 {
            entry[c] = entry[r];
        }
    }
    let cms = speed_kmh * 1000.0;
    let tt = w.t_end - w.t_start;
    let dt = jmin(1.0, jmax(0.1, jmin(w.rise, tt) / 12.0));
    let travel = a.chain[g] / cms;
    let mut min_lag = 0.0;
    let mut inflow: Vec<Vec<Inflow>> = (0..path.len()).map(|_| Vec::new()).collect();
    for c in 0..n {
        if entry[c] != c as i64 {
            continue;
        }
        let area = a.acc[c] * cell_km2;
        let lag = tc_hours(area) - tcg;
        let k = on_p[a.rec[c] as usize] as usize;
        inflow[k].push(Inflow { area, lag, local: false });
        if lag < min_lag {
            min_lag = lag;
        }
    }
    for k in 1..path.len() {
        let (c, up) = (path[k], path[k - 1]);
        let mut area = (a.acc[c] - a.acc[up]) * cell_km2;
        for e in &inflow[k] {
            area -= e.area;
        }
        if area > 0.01 {
            let lag = tc_hours(area) - tcg;
            inflow[k].push(Inflow { area, lag, local: true });
            if lag < min_lag {
                min_lag = lag;
            }
        }
    }
    let t0 = (w.t_start + min_lag - 2.0).floor();
    let n_t = (((w.t_end + travel * 2.0 + 48.0 - t0) / dt).ceil() + 1.0) as usize;
    let qg: Vec<f64> = (0..n_t).map(|i| q_of(w.gauge_at(t0 + i as f64 * dt))).collect();
    let qg_max = js_max(qg.iter().copied());
    let shifted = |lag: f64, scale: f64, out: &mut [f64]| {
        for (i, value) in out.iter_mut().enumerate().take(n_t) {
            let x = i as f64 - lag / dt;
            let i0 = x.floor();
            let f = x - i0;
            let at = |j: f64| qg[(j.max(0.0) as usize).min(n_t - 1)];
            let (v0, v1) = (at(i0), at(i0 + 1.0));
            *value += scale * (v0 + (v1 - v0) * f);
        }
    };
    let depth = |c: usize| jmax(0.5, w.w1[c] - jmin(a.dem[c] as f64 - 1.0, w.w0[c] - 0.5));
    let slope_at = |k: usize| -> f64 {
        let (mut u, mut d) = (k, k);
        while u > 0 && a.chain[path[u]] - a.chain[path[k]] < 1500.0 {
            u -= 1;
        }
        while d < path.len() - 1 && a.chain[path[k]] - a.chain[path[d]] < 1500.0 {
            d += 1;
        }
        let l = a.chain[path[u]] - a.chain[path[d]];
        if l > 0.0 {
            jmax(2e-5, (w.w1[path[u]] - w.w1[path[d]]).abs() / l)
        } else {
            2e-5
        }
    };
    let mut nodes = vec![0usize];
    let mut k = 0;
    while k < path.len() - 1 {
        let dd = jmin(0.3 * cms * depth(path[k]) / slope_at(k), 5e8);
        let lmin = jmin(jmax(jmax(cms * dt, (2.0 * dd) / cms), a.cell), 60000.0);
        let mut j = k + 1;
        while j < path.len() - 1 && a.chain[path[k]] - a.chain[path[j]] < lmin {
            j += 1;
        }
        nodes.push(j);
        k = j;
    }
    let mut flows = Vec::new();
    let mut q = qg.clone();
    let mut q_ref = qg_max;
    flows.push(Flow { k: 0, q: q.clone(), r#ref: q_ref, kk: f64::NAN, x: f64::NAN });
    for nn in 1..nodes.len() {
        let (k0, k1) = (nodes[nn - 1], nodes[nn]);
        let mut inp = q.clone();
        let mut add = 0.0;
        for entries in inflow.iter().take(k1 + 1).skip(k0 + 1) {
            for e in entries {
                let sc = e.area / ag;
                shifted(e.lag, sc, &mut inp);
                add += sc * qg_max;
            }
        }
        q_ref += add;
        let l = jmax(a.cell, a.chain[path[k0]] - a.chain[path[k1]]);
        let mut dsum = 0.0;
        for (kk, &cell) in path.iter().enumerate().take(k1).skip(k0) {
            dsum += 0.3 * cms * depth(cell) / slope_at(kk);
        }
        let dd = jmin(dsum / jmax(1.0, (k1 - k0) as f64), 5e8);
        // Floodplain storage: estimate floodplain area (cells within 2 m of the
        // channel bed along this reach) and widen the storage coefficient K so
        // the peak is attenuated/delayed in proportion to the floodplain.
        let mut fp_cells = 0usize;
        let bed = a.dem[path[k0]] as f64;
        for &cc in path.iter().take(k1 + 1).skip(k0) {
            let (cx, cy) = (cc % a.w, cc / a.w);
            for dy in -2..=2i64 {
                for dx in -2..=2i64 {
                    let (nx, ny) = (cx as i64 + dx, cy as i64 + dy);
                    if nx < 0 || ny < 0 || nx >= a.w as i64 || ny >= a.h as i64 { continue; }
                    let nn = ny as usize * a.w + nx as usize;
                    if a.valid[nn] == 0 { continue; }
                    if (a.dem[nn] as f64 - bed).abs() <= 2.0 { fp_cells += 1; }
                }
            }
        }
        let fp_ratio = (fp_cells as f64) / jmax(1.0, (k1 - k0 + 1) as f64);
        let kq = (l / cms) * (1.0 + 0.3 * fp_ratio);
        let x = jmax(0.0, jmin(jmin(0.5 - dd / (cms * l), (cms * dt) / (2.0 * l)), 0.5));
        let den = kq * (1.0 - x) + dt / 2.0;
        let c0 = (dt / 2.0 - kq * x) / den;
        let c1 = (dt / 2.0 + kq * x) / den;
        let c2 = (kq * (1.0 - x) - dt / 2.0) / den;
        let mut out = vec![0f64; n_t];
        out[0] = inp[0];
        for i in 1..n_t {
            out[i] = jmax(0.0, c0 * inp[i] + c1 * inp[i - 1] + c2 * out[i - 1]);
        }
        q = out;
        flows.push(Flow { k: k1, q: q.clone(), r#ref: q_ref, kk: kq, x });
    }
    let mut cell_a = vec![-1i32; n];
    let mut cell_f = vec![0f32; n];
    for nn in 1..flows.len() {
        let (k0, k1) = (flows[nn - 1].k, flows[nn].k);
        let l = a.chain[path[k0]] - a.chain[path[k1]];
        for kk in k0..=k1 {
            cell_a[path[kk]] = (nn - 1) as i32;
            cell_f[path[kk]] = (if l > 0.0 { (a.chain[path[k0]] - a.chain[path[kk]]) / l } else { 1.0 }) as f32;
        }
    }
    for c in 0..n {
        let e = entry[c];
        if e < 0 || a.stream[c] == 0 {
            continue;
        }
        let j = a.rec[e as usize] as usize;
        cell_a[c] = cell_a[j];
        cell_f[c] = cell_f[j];
    }
    let reaches = flows[1..].iter().map(|f| ((a.chain[path[0]] - a.chain[path[f.k]]) / 1000.0, f.kk, f.x)).collect();
    let tributaries = inflow.iter().flatten().filter(|e| !e.local).count();
    Some(Routed {
        t0,
        dt,
        n_t,
        flows,
        cell_a,
        cell_f,
        zb,
        span,
        q_pk: qg_max,
        exponent: bx,
        rated: use_r.is_some(),
        reaches,
        tributaries,
        extra_hours: (t0 + n_t as f64 * dt) - w.t_end,
    })
}

/// The water surface along the river at hour t (fills `out` at the wave's
/// cells; other cells keep their values).
pub fn wave_surface(w: &Wave, t: f64, out: &mut [f64]) {
    let span = w.hi - w.lo;
    let r = w.routed.as_ref();
    let (mut ti, mut tf) = (0usize, 0f64);
    if let Some(r) = r {
        let x = jmin((r.n_t - 1) as f64, jmax(0.0, (t - r.t0) / r.dt));
        ti = ((r.n_t as i64 - 2).max(0) as usize).min(x.floor() as usize);
        tf = x - ti as f64;
    }
    let bay = w.bay_at(t);
    for &c in &w.cells {
        let c = c as usize;
        let h = if let Some(up) = w.up.as_ref().filter(|u| u.k1[c] >= 0) {
            let r1 = w.rel(up.k1[c] as usize, t - up.d1[c] as f64);
            let rr = if up.k2[c] >= 0 {
                r1 * (1.0 - up.f[c] as f64) + w.rel(up.k2[c] as usize, t + up.d2[c] as f64) * up.f[c] as f64
            } else {
                r1
            };
            up.base + rr * up.rng
        } else if let Some(r) = r.filter(|r| r.cell_a[c] >= 0) {
            let n = r.cell_a[c] as usize;
            let f = r.cell_f[c] as f64;
            let (fa, fb) = (&r.flows[n], &r.flows[n + 1]);
            let qa = (fa.q[ti] + (fa.q[ti + 1] - fa.q[ti]) * tf) / fa.r#ref;
            let qb = (fb.q[ti] + (fb.q[ti + 1] - fb.q[ti]) * tf) / fb.r#ref;
            r.h_of((qa + (qb - qa) * f) * r.q_pk)
        } else {
            w.at(w.band[c] as usize, t - w.arrive[c] as f64)
        };
        let mut v = w.w0[c] + ((w.w1[c] - w.w0[c]) * (h - w.lo)) / span;
        if w.tide != 0.0 && bay > v {
            v = bay;
        }
        out[c] = v;
    }
}

/// The flood hour by hour: per cell, the first and last step it is wet and
/// at least 0.3 m deep, packed wet/deep states per step, and the gauge.
pub struct Timeline {
    pub t0: f64,
    pub step: f64,
    pub steps: usize,
    pub first_wet: Vec<i16>,
    pub last_wet: Vec<i16>,
    pub first_deep: Vec<i16>,
    pub last_deep: Vec<i16>,
    pub wet_count: Vec<i32>,
    pub gauge: Vec<f32>,
    pub words_per_step: usize,
    pub wet_bits: Vec<u32>,
    pub deep_bits: Vec<u32>,
    /// Per-step depth frames, u8 quantised to the frame's max depth (m);
    /// concatenated, `steps * n` bytes. Empty when no steps.
    pub depth_frames: Vec<u8>,
    /// Per-step max depth (m) used to dequantise `depth_frames`.
    pub depth_frame_max: Vec<f32>,
}

pub fn flood_timeline(a: &Analysis, s: &Scenario, o: &WaveOpts) -> Timeline {
    let w = wave_setup(a, s, o);
    let t0 = (w.t_start + w.min_a).floor() - 1.0;
    let t1 = (w.t_end + w.max_a).ceil() + 1.0;
    let step = jmax(or(o.step_hours, 1.0), (t1 - t0) / or(o.max_steps, 120.0));
    let steps = ((t1 - t0) / step).ceil() as usize + 1;
    let n = a.n;
    let (mut first_wet, mut last_wet) = (vec![-1i16; n], vec![-1i16; n]);
    let (mut first_deep, mut last_deep) = (vec![-1i16; n], vec![-1i16; n]);
    let mut wet_count = vec![0i32; steps];
    let mut gauge = vec![0f32; steps];
    let wps = n.div_ceil(32);
    let (mut wet_bits, mut deep_bits) = (vec![0u32; steps * wps], vec![0u32; steps * wps]);
    let mut wse = vec![f64::NAN; n];
    let mut depth_frames: Vec<u8> = Vec::with_capacity(steps * n);
    let mut depth_frame_max: Vec<f32> = Vec::with_capacity(steps);

    for k in 0..steps {
        let t = t0 + k as f64 * step;
        gauge[k] = w.gauge_at(t) as f32;
        wave_surface(&w, t, &mut wse);
        let mut sc = s.clone();
        sc.bay_level = w.bay_at(t);
        sc.wse = None;
        let run = inundate_with(a, &sc, wse.clone(), vec![0u8; n]);
        let mut cnt = 0;
        let mut mx = 0.0f32;
        for c in 0..n {
            if run.wet[c] == 0 || a.ocean[c] != 0 {
                continue;
            }
            cnt += 1;
            let word = k * wps + (c >> 5);
            let bit = 1u32 << (c & 31);
            wet_bits[word] |= bit;
            let deep = run.depth[c] as f64 >= 0.3;
            if deep {
                deep_bits[word] |= bit;
            }
            if first_wet[c] < 0 {
                first_wet[c] = k as i16;
            }
            last_wet[c] = k as i16;
            if deep {
                if first_deep[c] < 0 {
                    first_deep[c] = k as i16;
                }
                last_deep[c] = k as i16;
            }
            if run.depth[c] > mx {
                mx = run.depth[c];
            }
        }
        // encode this step's depths as u8 (scaled to the frame max)
        let scale = if mx > 0.0 { mx / 255.0 } else { 1.0 };
        depth_frame_max.push(mx);
        for c in 0..n {
            let d = if run.wet[c] != 0 && a.ocean[c] == 0 { run.depth[c] } else { 0.0 };
            let q = if d <= 0.0 { 0u8 } else { ((d / scale).round().min(255.0)) as u8 };
            depth_frames.push(q);
        }
        wet_count[k] = cnt;
    }
    Timeline { t0, step, steps, first_wet, last_wet, first_deep, last_deep, wet_count, gauge, words_per_step: wps, wet_bits, deep_bits, depth_frames, depth_frame_max }
}
