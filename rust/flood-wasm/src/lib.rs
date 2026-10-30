//! WebAssembly interface to flood-core, with no outside crates.
//!
//! The ABI is four plain exports: `flood_alloc`, `flood_free`, `flood_run` and
//! `flood_out_len`.
//! `flood_run(op, input)` takes an operation name and a "bag" of named arrays and
//! returns a bag. A bag is: u32 count, then per entry u8 name length, name,
//! u8 type (0 f64, 1 f32, 2 i32, 3 u8, 4 i16, 5 u32), u32 element count and
//! the elements, all little-endian. Scalars are one-element f64 arrays.
//! Analyses and flood waves stay in the module between calls, by handle.
//! viewer/flood-wasm.js turns this back into the FloodCore API.

use flood_core::*;
use std::cell::RefCell;
use std::collections::HashMap;

pub enum Val {
    F64(Vec<f64>),
    F32(Vec<f32>),
    I32(Vec<i32>),
    U8(Vec<u8>),
    I16(Vec<i16>),
    U32(Vec<u32>),
}

impl Val {
    /// Any numeric array as f64s.
    fn to_f64(&self) -> Vec<f64> {
        match self {
            Val::F64(v) => v.clone(),
            Val::F32(v) => v.iter().map(|&x| x as f64).collect(),
            Val::I32(v) => v.iter().map(|&x| x as f64).collect(),
            Val::U8(v) => v.iter().map(|&x| x as f64).collect(),
            Val::I16(v) => v.iter().map(|&x| x as f64).collect(),
            Val::U32(v) => v.iter().map(|&x| x as f64).collect(),
        }
    }
}

pub struct Bag(HashMap<String, Val>);

/// Plain numbers that can be copied byte for byte (the bag is little-endian,
/// as are WebAssembly and the machines we build on).
pub trait Plain: Copy + Default {}
impl Plain for f64 {}
impl Plain for f32 {}
impl Plain for i32 {}
impl Plain for u8 {}
impl Plain for i16 {}
impl Plain for u32 {}

#[cfg(not(target_endian = "little"))]
compile_error!("the bag format assumes a little-endian machine");

fn read_vec<T: Plain>(b: &[u8], p: usize, n: usize) -> (usize, Vec<T>) {
    let sz = std::mem::size_of::<T>();
    let bytes = &b[p..p + n * sz];
    let mut v: Vec<T> = vec![T::default(); n];
    // SAFETY: T is a plain number type; the destination holds n * sz bytes.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), v.as_mut_ptr() as *mut u8, n * sz) };
    (p + n * sz, v)
}

fn bytes_of<T: Plain>(v: &[T]) -> &[u8] {
    // SAFETY: T is a plain number type with no padding.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

impl Bag {
    pub fn decode(b: &[u8]) -> Bag {
        let mut m = HashMap::new();
        if b.len() < 4 {
            return Bag(m);
        }
        let count = u32::from_le_bytes(b[0..4].try_into().unwrap()) as usize;
        let mut p = 4;
        for _ in 0..count {
            let nl = b[p] as usize;
            let name = String::from_utf8_lossy(&b[p + 1..p + 1 + nl]).into_owned();
            p += 1 + nl;
            let ty = b[p];
            let n = u32::from_le_bytes(b[p + 1..p + 5].try_into().unwrap()) as usize;
            p += 5;
            let val = match ty {
                0 => { let (q, v) = read_vec::<f64>(b, p, n); p = q; Val::F64(v) }
                1 => { let (q, v) = read_vec::<f32>(b, p, n); p = q; Val::F32(v) }
                2 => { let (q, v) = read_vec::<i32>(b, p, n); p = q; Val::I32(v) }
                3 => { let v = b[p..p + n].to_vec(); p += n; Val::U8(v) }
                4 => { let (q, v) = read_vec::<i16>(b, p, n); p = q; Val::I16(v) }
                _ => { let (q, v) = read_vec::<u32>(b, p, n); p = q; Val::U32(v) }
            };
            m.insert(name, val);
        }
        Bag(m)
    }
    pub fn has(&self, k: &str) -> bool {
        self.0.contains_key(k)
    }
    /// A scalar, or NaN when missing.
    pub fn num(&self, k: &str) -> f64 {
        match self.0.get(k) {
            Some(v) => v.to_f64().first().copied().unwrap_or(f64::NAN),
            None => f64::NAN,
        }
    }
    pub fn f64s(&self, k: &str) -> Option<Vec<f64>> {
        self.0.get(k).map(|v| v.to_f64())
    }
    pub fn f32s(&self, k: &str) -> Option<Vec<f32>> {
        match self.0.get(k) {
            Some(Val::F32(v)) => Some(v.clone()),
            Some(v) => Some(v.to_f64().iter().map(|&x| x as f32).collect()),
            None => None,
        }
    }
    pub fn i32s(&self, k: &str) -> Option<Vec<i32>> {
        match self.0.get(k) {
            Some(Val::I32(v)) => Some(v.clone()),
            Some(v) => Some(v.to_f64().iter().map(|&x| x as i32).collect()),
            None => None,
        }
    }
    pub fn u8s(&self, k: &str) -> Option<Vec<u8>> {
        match self.0.get(k) {
            Some(Val::U8(v)) => Some(v.clone()),
            Some(v) => Some(v.to_f64().iter().map(|&x| (x != 0.0 && !x.is_nan()) as u8).collect()),
            None => None,
        }
    }
    pub fn u32s(&self, k: &str) -> Option<Vec<u32>> {
        match self.0.get(k) {
            Some(Val::U32(v)) => Some(v.clone()),
            Some(v) => Some(v.to_f64().iter().map(|&x| x as u32).collect()),
            None => None,
        }
    }
    pub fn i16s(&self, k: &str) -> Option<Vec<i16>> {
        match self.0.get(k) {
            Some(Val::I16(v)) => Some(v.clone()),
            Some(v) => Some(v.to_f64().iter().map(|&x| x as i16).collect()),
            None => None,
        }
    }
}

/// Builds an output bag.
pub struct Out {
    buf: Vec<u8>,
    count: u32,
}

impl Default for Out {
    fn default() -> Self {
        Out { buf: vec![0; 4], count: 0 }
    }
}

impl Out {
    fn head(&mut self, k: &str, ty: u8, n: usize) {
        self.buf.push(k.len() as u8);
        self.buf.extend_from_slice(k.as_bytes());
        self.buf.push(ty);
        self.buf.extend_from_slice(&(n as u32).to_le_bytes());
        self.count += 1;
    }
    pub fn num(&mut self, k: &str, v: f64) -> &mut Self {
        self.f64s(k, &[v])
    }
    pub fn f64s(&mut self, k: &str, v: &[f64]) -> &mut Self {
        self.head(k, 0, v.len());
        self.buf.extend_from_slice(bytes_of(v));
        self
    }
    pub fn f32s(&mut self, k: &str, v: &[f32]) -> &mut Self {
        self.head(k, 1, v.len());
        self.buf.extend_from_slice(bytes_of(v));
        self
    }
    pub fn i32s(&mut self, k: &str, v: &[i32]) -> &mut Self {
        self.head(k, 2, v.len());
        self.buf.extend_from_slice(bytes_of(v));
        self
    }
    pub fn u8s(&mut self, k: &str, v: &[u8]) -> &mut Self {
        self.head(k, 3, v.len());
        self.buf.extend_from_slice(v);
        self
    }
    pub fn i16s(&mut self, k: &str, v: &[i16]) -> &mut Self {
        self.head(k, 4, v.len());
        self.buf.extend_from_slice(bytes_of(v));
        self
    }
    pub fn u32s(&mut self, k: &str, v: &[u32]) -> &mut Self {
        self.head(k, 5, v.len());
        self.buf.extend_from_slice(bytes_of(v));
        self
    }
    pub fn finish(mut self) -> Vec<u8> {
        self.buf[0..4].copy_from_slice(&self.count.to_le_bytes());
        self.buf
    }
}

thread_local! {
    static INERTIAL: RefCell<Option<inertial::Solver>> = const { RefCell::new(None) };
    static INUNDATION: RefCell<Option<inundation::Solver>> = const { RefCell::new(None) };
    static NEST: RefCell<Option<nest::Nest<tsunami::Solver>>> = const { RefCell::new(None) };
    // regional -> intermediate grid -> local
    static NEST3: RefCell<Option<nest::Nest<nest::Nest<tsunami::Solver>>>> = const { RefCell::new(None) };
    static DAM: RefCell<Option<dam::Run>> = const { RefCell::new(None) };
    // regional recordings kept for one-way coupled runs that differ only in their local settings, by the key the caller gives
    static RECORDINGS: RefCell<HashMap<Vec<u8>, (coupling::Recording, f64)>> = RefCell::new(HashMap::new());
    // the ground that is dry at mean sea level in the running tsunami model, and the time the wave reached its edge (what arrival times count from)
    static TSUNAMI_LAND: RefCell<(Vec<u8>, f64)> = const { RefCell::new((Vec::new(), 0.0)) };
    static TSUNAMI: RefCell<Option<tsunami::Solver>> = const { RefCell::new(None) };
    static ANALYSES: RefCell<Vec<Option<Analysis>>> = const { RefCell::new(Vec::new()) };
    static WAVES: RefCell<Vec<Option<Wave>>> = const { RefCell::new(Vec::new()) };
    static NETS: RefCell<Vec<Option<net::Net>>> = const { RefCell::new(Vec::new()) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn store<T>(slots: &RefCell<Vec<Option<T>>>, v: T) -> usize {
    let mut s = slots.borrow_mut();
    if let Some(i) = s.iter().position(|x| x.is_none()) {
        s[i] = Some(v);
        i
    } else {
        s.push(Some(v));
        s.len() - 1
    }
}

fn with_analysis<R>(h: f64, f: impl FnOnce(&Analysis) -> R) -> Result<R, String> {
    ANALYSES.with(|s| {
        let s = s.borrow();
        match s.get(h as usize).and_then(|x| x.as_ref()) {
            Some(a) if h >= 0.0 => Ok(f(a)),
            _ => Err("no such analysis".into()),
        }
    })
}

fn with_net<R>(h: f64, f: impl FnOnce(&mut net::Net) -> R) -> Result<R, String> {
    NETS.with(|s| {
        let mut s = s.borrow_mut();
        match s.get_mut(h as usize).and_then(|x| x.as_mut()) {
            Some(n) if h >= 0.0 => Ok(f(n)),
            _ => Err("no such road network".into()),
        }
    })
}

fn with_wave<R>(h: f64, f: impl FnOnce(&Wave) -> R) -> Result<R, String> {
    WAVES.with(|s| {
        let s = s.borrow();
        match s.get(h as usize).and_then(|x| x.as_ref()) {
            Some(w) if h >= 0.0 => Ok(f(w)),
            _ => Err("no such flood wave".into()),
        }
    })
}

fn grid_of(b: &Bag) -> Result<Grid, String> {
    let w = b.num("W");
    let h = b.num("H");
    if !(w >= 1.0 && h >= 1.0) {
        return Err("grid needs W and H".into());
    }
    let (w, h) = (w as usize, h as usize);
    let dem = b.f32s("dem").ok_or("grid needs dem")?;
    if dem.len() != w * h {
        return Err("dem is the wrong size".into());
    }
    Ok(Grid { w, h, cell: b.num("cell"), dem, valid: b.u8s("valid"), inflow: b.f32s("inflow"), d8: b.i16s("d8") })
}

fn put_grid(o: &mut Out, g: &Grid) {
    o.num("W", g.w as f64).num("H", g.h as f64).num("cell", g.cell).f32s("dem", &g.dem);
    if let Some(v) = &g.valid {
        o.u8s("valid", v);
    }
    if let Some(v) = &g.inflow {
        o.f32s("inflow", v);
    }
}

fn put_analysis(o: &mut Out, a: &Analysis) {
    o.num("W", a.w as f64)
        .num("H", a.h as f64)
        .num("cell", a.cell)
        .num("N", a.n as f64)
        .f32s("dem", &a.dem)
        .u8s("valid", &a.valid)
        .u8s("ocean", &a.ocean)
        .i32s("order", &a.order)
        .num("nOrder", a.n_order as f64)
        .i32s("rec", &a.rec)
        .f64s("acc", &a.acc)
        .f64s("chain", &a.chain)
        .u8s("stream", &a.stream)
        .i32s("recvStream", &a.recv_stream)
        .num("mainOutlet", a.main_outlet as f64)
        .num("defaultGauge", a.default_gauge as f64)
        .num("streamAreaKm2", a.stream_area_km2)
        .num("byPointers", a.routed_by_pointers as u8 as f64);
    if let Some(f) = &a.filled {
        o.f64s("filled", f);
    }
}

/// An analysis made elsewhere (the worker, or the JavaScript model).
fn load_analysis(b: &Bag) -> Result<Analysis, String> {
    let w = b.num("W") as usize;
    let h = b.num("H") as usize;
    let n = w * h;
    let need = |k: &str| -> Result<(), String> { if b.has(k) { Ok(()) } else { Err(format!("analysis needs {}", k)) } };
    for k in ["dem", "valid", "ocean", "order", "rec", "acc", "chain", "stream", "recvStream"] {
        need(k)?;
    }
    let a = Analysis {
        w,
        h,
        cell: b.num("cell"),
        n,
        dem: b.f32s("dem").unwrap(),
        valid: b.u8s("valid").unwrap(),
        ocean: b.u8s("ocean").unwrap(),
        filled: b.f64s("filled"),
        order: b.i32s("order").unwrap(),
        n_order: b.num("nOrder") as usize,
        rec: b.i32s("rec").unwrap(),
        rec_dist: Vec::new(),
        acc: b.f64s("acc").unwrap(),
        chain: b.f64s("chain").unwrap(),
        stream: b.u8s("stream").unwrap(),
        recv_stream: b.i32s("recvStream").unwrap(),
        main_outlet: b.num("mainOutlet") as i32,
        default_gauge: nan_to(b.num("defaultGauge"), -1.0) as i32,
        stream_area_km2: b.num("streamAreaKm2"),
        routed_by_pointers: b.num("byPointers") == 1.0,
    };
    for (k, l) in [("dem", a.dem.len()), ("rec", a.rec.len()), ("acc", a.acc.len()), ("chain", a.chain.len()), ("stream", a.stream.len())] {
        if l != n {
            return Err(format!("analysis {} is the wrong size", k));
        }
    }
    Ok(a)
}

fn nan_to(v: f64, d: f64) -> f64 {
    if v.is_nan() {
        d
    } else {
        v
    }
}

fn scenario_of(b: &Bag) -> Scenario {
    let cc = b.f64s("controlCell").unwrap_or_default();
    let cl = b.f64s("controlLevel").unwrap_or_default();
    Scenario {
        gauge: nan_to(b.num("gauge"), -1.0) as i32,
        gauge_level: b.num("gaugeLevel"),
        bay_level: b.num("bayLevel"),
        upstream_gradient: b.num("upstreamGradient"),
        controls: cc.iter().zip(cl.iter()).map(|(&c, &l)| (c as i64, l)).collect(),
        gates: b.f64s("gates").unwrap_or_default().iter().map(|&c| c as i64).collect(),
        levee: b.u8s("levee"),
        wse: b.f64s("wse"),
        backwater: b.num("backwater") > 0.5,
    }
}

fn series(t: Option<Vec<f64>>, v: Option<Vec<f64>>) -> Option<Series> {
    match (t, v) {
        (Some(t), Some(v)) => Some(t.into_iter().zip(v).collect()),
        _ => None,
    }
}

fn wave_opts_of(b: &Bag) -> WaveOpts {
    let mut others = Vec::new();
    if let (Some(cells), Some(lens), Some(t), Some(v)) = (b.f64s("othersCell"), b.f64s("othersLen"), b.f64s("othersT"), b.f64s("othersV")) {
        let mut p = 0;
        for (k, &c) in cells.iter().enumerate() {
            let l = lens[k] as usize;
            others.push((c as i64, t[p..p + l].iter().copied().zip(v[p..p + l].iter().copied()).collect()));
            p += l;
        }
    }
    WaveOpts {
        base_level: b.num("baseLevel"),
        rise_hours: b.num("riseHours"),
        fall_hours: b.num("fallHours"),
        speed_kmh: b.num("speedKmh"),
        flatten: b.num("flatten"),
        route: b.num("route") == 1.0,
        tide: if b.has("tideAmp") { Some((b.num("tideAmp"), b.num("tideLow") == 1.0)) } else { None },
        rating: if b.has("ratingB") { Some((b.num("ratingB"), b.num("ratingDepth"))) } else { None },
        release: if b.has("releaseFrac") { Some((b.num("releaseStart"), b.num("releaseHours"), b.num("releaseFrac"))) } else { None },
        hydro: series(b.f64s("hydroT"), b.f64s("hydroV")),
        sea: series(b.f64s("seaT"), b.f64s("seaV")),
        others,
        step_hours: b.num("stepHours"),
        max_steps: b.num("maxSteps"),
    }
}

/// A run handed back from JavaScript (only what the callers use).
fn run_of(b: &Bag, p: &str) -> Result<Run, String> {
    let wet = b.u8s(&format!("{}wet", p)).ok_or("run needs wet")?;
    let n = wet.len();
    Ok(Run {
        wet,
        depth: b.f32s(&format!("{}depth", p)).ok_or("run needs depth")?,
        level: b.f32s(&format!("{}level", p)).unwrap_or_else(|| vec![f32::NAN; n]),
        wse: b.f64s(&format!("{}wse", p)).unwrap_or_else(|| vec![f64::NAN; n]),
        on_path: vec![0; n],
        kind: None,
        summary: None,
    })
}

fn put_run(o: &mut Out, r: &Run, slim: bool) {
    // slim runs omit wse/onPath: the callers that look at them rebuild with
    // the flag off (see docs/wasm-bag-trim-design.md)
    o.u8s("wet", &r.wet).f32s("depth", &r.depth).f32s("level", &r.level);
    if !slim {
        o.f64s("wse", &r.wse).u8s("onPath", &r.on_path);
    }
    if let Some(k) = &r.kind {
        o.u8s("kind", k);
    }
    if let Some(m) = &r.summary {
        o.num("excessMm", m.excess_mm)
            .num("runoffCoeff", m.runoff_coeff)
            .num("creekKm2", m.creek_km2)
            .num("overlandKm2", m.overland_km2)
            .num("pondKm2", m.pond_km2)
            .num("maxCreekRise", m.max_creek_rise)
            .num("pipedMm", m.piped_mm)
            .num("urbanKm2", m.urban_km2);
    }
}

fn put_wave(o: &mut Out, w: &Wave) {
    o.num("lo", w.lo)
        .num("hi", w.hi)
        .f64s("w0", &w.w0)
        .f64s("w1", &w.w1)
        .i32s("cells", &w.cells)
        .f32s("arrive", &w.arrive)
        .num("minA", w.min_a)
        .num("maxA", w.max_a)
        .num("rise", w.rise)
        .num("fall", w.fall)
        .u8s("band", &w.band)
        .num("bands", w.n_bands() as f64)
        .num("tStart", w.t_start)
        .num("tEnd", w.t_end)
        .num("tPeak", w.t_peak)
        .num("tide", w.tide);
    if let Some((lo, hi)) = w.sea_recorded {
        o.num("seaLo", lo).num("seaHi", hi);
    }
    if let Some((frac, top, rise)) = w.release_info {
        o.num("releaseFrac", frac).num("releasePeakWith", top).num("releaseRise", rise);
    }
    if let Some(u) = &w.up {
        o.num("upGauges", u.gauges as f64)
            .num("upBelow", u.below as f64)
            .f64s("upUsed", &u.used.iter().map(|&x| x as f64).collect::<Vec<_>>())
            .num("upBase", u.base)
            .num("upRng", u.rng)
            .i16s("upK1", &u.k1)
            .i16s("upK2", &u.k2);
    }
    if let Some(r) = &w.routed {
        o.num("rT0", r.t0)
            .num("rDt", r.dt)
            .num("rNT", r.n_t as f64)
            .num("rQPk", r.q_pk)
            .num("rExponent", r.exponent)
            .num("rRated", r.rated as u8 as f64)
            .num("rTributaries", r.tributaries as f64)
            .num("rExtraHours", r.extra_hours)
            .f64s("rReachKm", &r.reaches.iter().map(|x| x.0).collect::<Vec<_>>())
            .f64s("rReachK", &r.reaches.iter().map(|x| x.1).collect::<Vec<_>>())
            .f64s("rReachX", &r.reaches.iter().map(|x| x.2).collect::<Vec<_>>())
            .f64s("rFlowK", &r.flows.iter().map(|f| f.k as f64).collect::<Vec<_>>())
            .f64s("rFlowRef", &r.flows.iter().map(|f| f.r#ref).collect::<Vec<_>>())
            .f64s("rFlowKK", &r.flows.iter().map(|f| f.kk).collect::<Vec<_>>())
            .f64s("rFlowX", &r.flows.iter().map(|f| f.x).collect::<Vec<_>>())
            .f64s("rQ", &r.flows.iter().flat_map(|f| f.q.iter().copied()).collect::<Vec<_>>())
            .i32s("rCellA", &r.cell_a)
            .f32s("rCellF", &r.cell_f);
    }
}

fn levees_of(b: &Bag) -> Vec<Levee> {
    let n = b.num("leveeCount");
    if !matches!(n.partial_cmp(&1.0), Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)) {
        return Vec::new();
    }
    let cells = b.f64s("leveeCells").unwrap_or_default();
    let clen = b.f64s("leveeCellLen").unwrap_or_default();
    let height = b.f64s("leveeHeight").unwrap_or_default();
    let failed = b.f64s("leveeFailed").unwrap_or_default();
    let br = b.f64s("leveeBreaches").unwrap_or_default();
    let blen = b.f64s("leveeBreachLen").unwrap_or_default();
    let bw = b.f64s("leveeBreachWidth").unwrap_or_default();
    let (mut pc, mut pb) = (0usize, 0usize);
    let mut out = Vec::new();
    for k in 0..n as usize {
        let (lc, lb) = (clen[k] as usize, blen[k] as usize);
        out.push(Levee {
            cells: cells[pc..pc + lc].iter().map(|&c| c as i64).collect(),
            height: if height[k].is_nan() { None } else { Some(height[k]) },
            failed: failed[k] == 1.0,
            breaches: br[pb..pb + lb].iter().map(|&c| c as i64).collect(),
            breach_width: if bw[k].is_nan() { None } else { Some(bw[k]) },
        });
        pc += lc;
        pb += lb;
    }
    out
}

// What a nonlinear tsunami model reports at a step: its fields; with the dry-land mask, what it has flooded; and on request what it has seen at its worst, kept every step.
fn inundation_frame(o: &mut Out, s: &inundation::Solver, extremes: bool) {
    for (name, values) in [("eta", &s.eta), ("peak", &s.peak), ("water", &s.water), ("speed", &s.speed)] {
        o.f32s(name, &values.iter().map(|v| *v as f32).collect::<Vec<_>>());
    }
    let (land, origin) = TSUNAMI_LAND.with(|l| l.borrow().clone());
    if land.len() == s.water.len() {
        let f = s.flood_summary(&land);
        o.num("floodedHectares", f.flooded_hectares).num("maxLandDepth", f.max_land_depth).num("floodedNowHectares", f.flooded_now_hectares);
    }
    if !s.probe_arrival.is_empty() {
        o.f64s("probeArrival", &s.probe_arrival);
    }
    if extremes {
        o.num("maxSpeed", s.max_speed());
        // deepest water on land, highest wave at sea; arrival in seconds from the time the wave reached the model's edge (-1 where it did not come)
        let value: Vec<f32> = (0..s.water.len()).map(|i| if land.get(i).copied().unwrap_or(0) != 0 { s.peak_depth[i] } else { s.peak[i] } as f32).collect();
        let arrival: Vec<f32> = s.arrival.iter().map(|a| if *a >= 0.0 { (*a - origin).max(0.0) as f32 } else { -1.0 }).collect();
        o.f32s("peakValue", &value).f32s("peakTime", &s.peak_time.iter().map(|v| *v as f32).collect::<Vec<_>>())
            .f32s("peakSpeed", &s.peak_speed.iter().map(|v| *v as f32).collect::<Vec<_>>()).f32s("arrival", &arrival).u8s("peakClass", &s.peak_class);
    }
}

// An area model's terrain from the bag (W, H, cell, dem and the optional valid and ocean masks), checked.
fn area_of(b: &Bag) -> Result<dam::Area, String> {
    let (w, h) = (b.num("W") as usize, b.num("H") as usize);
    let dem = b.f64s("dem").ok_or("missing elevations")?;
    if w == 0 || h == 0 || dem.len() != w.checked_mul(h).ok_or("grid overflow")? { return Err("the elevations do not match the grid".into()); }
    let (valid, ocean) = (b.u8s("valid").unwrap_or_default(), b.u8s("ocean").unwrap_or_default());
    if (!valid.is_empty() && valid.len() != dem.len()) || (!ocean.is_empty() && ocean.len() != dem.len()) { return Err("the masks do not match the grid".into()); }
    Ok(dam::Area { w, h, cell: b.num("cell"), dem, valid, ocean })
}

// The solver's block grid from the bag (the prefix `g`: gW, gH, gCell, gDem, gValid, gOcean, gFactor).
fn prepared_of(b: &Bag) -> Result<inertial_grid::Prepared, String> {
    let (w, h) = (b.num("gW") as usize, b.num("gH") as usize);
    let (dem, valid, ocean) = (b.f64s("gDem").ok_or("missing the solver grid")?, b.u8s("gValid").ok_or("missing the solver grid")?, b.u8s("gOcean").ok_or("missing the solver grid")?);
    if w == 0 || h == 0 || dem.len() != w * h || valid.len() != dem.len() || ocean.len() != dem.len() || b.num("gFactor").is_nan() || b.num("gFactor") < 1.0 { return Err("the solver grid is not consistent".into()); }
    Ok(inertial_grid::Prepared { w, h, cell: b.num("gCell"), dem, valid, ocean, factor: b.num("gFactor") as usize })
}

fn place_of(b: &Bag, prefix: &str) -> Result<place::Place, String> {
    let extent = b.f64s(&format!("{prefix}Extent")).filter(|v| v.len() == 4).ok_or("missing place extent")?;
    let (w, h) = (b.num(&format!("{prefix}W")), b.num(&format!("{prefix}H")));
    if !(w >= 1.0 && h >= 1.0) { return Err("invalid place grid".into()); }
    Ok(place::Place { extent: [extent[0], extent[1], extent[2], extent[3]], w: w as usize, h: h as usize, zone: if b.num(&format!("{prefix}Zone")).is_finite() { b.num(&format!("{prefix}Zone")) as i32 } else { 56 } })
}

/// Run one operation. Errors come back as a bag with "error" (UTF-8 bytes).
pub fn dispatch(op: &str, b: &Bag) -> Result<Vec<u8>, String> {
    let mut o = Out::default();
    match op {
        "tsunamiStart" => {
            TSUNAMI.with(|s| *s.borrow_mut() = None);
            INUNDATION.with(|s| *s.borrow_mut() = None);
            NEST.with(|s| *s.borrow_mut() = None);
            NEST3.with(|s| *s.borrow_mut() = None);
            TSUNAMI_LAND.with(|l| *l.borrow_mut() = (b.u8s("land").unwrap_or_default(), if b.num("arrivalOrigin").is_finite() { b.num("arrivalOrigin") } else { 0.0 }));
            if b.num("method") == 2.0 {
                let mut solver = inundation::Solver::new(
                    b.num("W") as usize, b.num("H") as usize, b.num("cell"),
                    b.f64s("bed").ok_or("missing bed elevations")?,
                    b.f64s("depth").ok_or("missing initial water depths")?,
                    b.f64s("eta").ok_or("missing initial wave")?, b.num("absorbing") == 1.0,
                    b.num("roughness"),
                )?;
                if b.num("order") == 2.0 { solver.set_order(2)?; }
                if let Some(valid) = b.u8s("valid") { solver.set_valid(valid)?; }
                // A dam wall giving way: the bed of these cells is lowered to the given levels between the start time and start + duration.
                if let (Some(cells), Some(to)) = (b.f64s("breachCells"), b.f64s("breachTo")) {
                    solver.set_breach(cells.iter().map(|c| *c as usize).collect(), to, b.num("breachStart"), b.num("breachSeconds"))?;
                }
                let arrival_depth = b.num("arrivalDepth");
                if arrival_depth.is_finite() { solver.set_arrival_depth(arrival_depth)?; }
                // gauges: cells whose first departure from their starting level is kept every step
                if let Some(cells) = b.f64s("probes") { solver.set_probes(cells.iter().map(|c| *c as usize).collect(), if b.num("probeThreshold").is_finite() { b.num("probeThreshold") } else { 0.05 })?; }
                // One-way coupling: each edge carries a series of incoming
                // surface displacement (samples x points) at shared times.
                if let Some(times) = b.f64s("forceTimes") {
                    for (code, key) in ["forceNorth", "forceEast", "forceSouth", "forceWest"].into_iter().enumerate() {
                        let Some(values) = b.f64s(key) else { continue };
                        if times.is_empty() || values.len() % times.len() != 0 { return Err("boundary forcing does not match its times".into()); }
                        let edge = inundation::Edge::from_code(code).unwrap();
                        solver.set_forcing(edge, times.clone(), values.clone(), values.len() / times.len())?;
                    }
                }
                if let (Some(times), Some(level)) = (b.f64s("levelTimes"), b.f64s("level")) { solver.set_level(times, level)?; }
                if b.num("nest") == 1.0 || b.num("nest") == 2.0 {
                    // Two-way nesting: a regional model stepped alongside this one, handing its wave over at the open edges and taking the local surface back.
                    let parent = tsunami::Solver::new(
                        b.num("nestW") as usize, b.num("nestH") as usize, b.num("nestCell"),
                        b.f64s("nestDepth").ok_or("missing regional depths")?, b.f64s("nestEta").ok_or("missing regional wave")?, b.num("nestAbsorbing") == 1.0,
                    )?;
                    if b.num("nestMethod") == 3.0 { return Err("two-way nesting needs the staggered regional scheme".into()); }
                    let bounds = b.f64s("nestBounds").filter(|v| v.len() == 4).ok_or("missing regional bounds")?;
                    let extent = b.f64s("nestExtent").filter(|v| v.len() == 4).ok_or("missing local extent")?;
                    let open: Vec<inundation::Edge> = b.f64s("nestEdges").unwrap_or_default().iter().filter_map(|c| inundation::Edge::from_code(*c as usize)).collect();
                    let optional = |k: &str| { let v = b.num(k); if v.is_finite() { Some(v) } else { None } };
                    let geography = nest::Geography { bounds: [bounds[0], bounds[1], bounds[2], bounds[3]], extent: [extent[0], extent[1], extent[2], extent[3]], zone: if b.num("nestZone").is_finite() { b.num("nestZone") as i32 } else { 56 } };
                    let tuning = nest::Tuning { per_edge: if b.num("nestPerEdge").is_finite() { b.num("nestPerEdge") as usize } else { 16 }, margin: optional("nestMargin"), ramp: optional("nestRamp") };
                    let threshold = if b.num("nestThreshold").is_finite() { b.num("nestThreshold") } else { 0.001 };
                    let max_seconds = if b.num("nestMaxSeconds").is_finite() { b.num("nestMaxSeconds") } else { 21600.0 };
                    let strength = if b.num("nestStrength").is_finite() { b.num("nestStrength") } else { 0.25 };
                    if b.num("nest") == 2.0 {
                        // Through an intermediate grid (see nest_grid.rs): regional -> intermediate (nonlinear, about 250 m, the local terrain averaged and the regional sea around it) -> local.
                        let bed = b.f64s("bed").ok_or("missing bed elevations")?;
                        let valid = b.u8s("valid");
                        let terrain = nest_grid::LocalTerrain { w: solver.w, h: solver.h, cell: solver.cell, extent: [extent[0], extent[1], extent[2], extent[3]], bed: &bed, valid: valid.as_deref() };
                        let regional = nest_grid::RegionalDepths { w: parent.w, h: parent.h, bounds: geography.bounds, depth: &parent.depth };
                        let mid_cell = if b.num("midCell").is_finite() { b.num("midCell") } else { 250.0 };
                        let mid_margin = if b.num("midMargin").is_finite() { b.num("midMargin") } else { 6000.0 };
                        let grid = nest_grid::intermediate(&terrain, &regional, geography.zone, mid_cell, mid_margin)?;
                        let mid = inundation::Solver::new(grid.w, grid.h, grid.cell, grid.bed.clone(), grid.reference.clone(), vec![0.0; grid.w * grid.h], false, b.num("roughness"))?;
                        let all = [inundation::Edge::North, inundation::Edge::East, inundation::Edge::South, inundation::Edge::West];
                        let up_geography = nest::Geography { extent: grid.extent, ..geography };
                        let up_plan = nest::plan_geographic(&parent, &mid, &up_geography, &all, &tuning)?;
                        let (up_handovers, up_snapped) = (up_plan.handovers.len(), up_plan.snapped);
                        let inner = nest::Nest::new(parent, mid, up_plan, strength, threshold, max_seconds)?;
                        let (mx0, my1) = (grid.extent[0], grid.extent[3]);
                        let to_mid = |x: f64, y: f64| ((extent[0] + x * solver.cell - mx0) / grid.cell, (my1 - (extent[3] - y * solver.cell)) / grid.cell);
                        let plan = nest::plan_with(&inner, &solver, &open, tuning.per_edge, tuning.margin, tuning.ramp, &to_mid)?;
                        let (handovers, snapped, points) = (plan.handovers.len(), plan.snapped, plan.points.len());
                        let nested = nest::Nest::new(inner, solver, plan, strength, threshold, max_seconds)?;
                        o.num("dt", nested.child.dt).num("nestOffset", nested.offset + nested.parent.offset).num("nestHandovers", handovers as f64).num("nestSnapped", (snapped + up_snapped) as f64).num("nestPoints", points as f64)
                            .num("midW", grid.w as f64).num("midH", grid.h as f64).num("midCell", grid.cell).num("midHandovers", up_handovers as f64);
                        NEST3.with(|s| *s.borrow_mut() = Some(nested));
                    } else {
                        let plan = nest::plan_geographic(&parent, &solver, &geography, &open, &tuning)?;
                        let (handovers, snapped, points) = (plan.handovers.len(), plan.snapped, plan.points.len());
                        let nested = nest::Nest::new(parent, solver, plan, strength, threshold, max_seconds)?;
                        o.num("dt", nested.child.dt).num("nestOffset", nested.offset).num("nestHandovers", handovers as f64).num("nestSnapped", snapped as f64).num("nestPoints", points as f64);
                        NEST.with(|s| *s.borrow_mut() = Some(nested));
                    }
                } else if b.num("couple") == 1.0 || b.num("couple") == 2.0 {
                    // One-way coupling in Rust: the incoming wave at the open edges comes from a regional run recorded here (1) or from a series (2), and a rising tide can sit on it.
                    let local_seconds = if b.num("coupleLocalSeconds").is_finite() { b.num("coupleLocalSeconds") } else { 3600.0 };
                    if b.f64s("levelTimes").is_none() {
                        if let Some((times, level)) = coupling::level_series(local_seconds, b.num("tideRange"), 44712.0, 60.0) { solver.set_level(times, level)?; }
                    }
                    let sea: Vec<inundation::Edge> = b.f64s("nestEdges").unwrap_or_default().iter().filter_map(|c| inundation::Edge::from_code(*c as usize)).collect();
                    let forcing = if b.num("couple") == 2.0 {
                        let open = coupling::open_edges(&sea, solver.w, solver.h, &solver.reference)?;
                        coupling::forcing_from_series(&open, &b.f64s("seriesTimes").ok_or("missing series times")?, &b.f64s("seriesValues").ok_or("missing series values")?, local_seconds, 0.02)?
                    } else {
                        let mut parent = tsunami::Solver::new(
                            b.num("nestW") as usize, b.num("nestH") as usize, b.num("nestCell"),
                            b.f64s("nestDepth").ok_or("missing regional depths")?, b.f64s("nestEta").ok_or("missing regional wave")?, b.num("nestAbsorbing") == 1.0,
                        )?;
                        if b.num("nestMethod") == 1.0 { parent.method = tsunami::Method::FiniteVolume; }
                        if b.num("nestMethod") == 3.0 { parent.method = tsunami::Method::Dispersive; parent.advance(0)?; }
                        let bounds = b.f64s("nestBounds").filter(|v| v.len() == 4).ok_or("missing regional bounds")?;
                        let extent = b.f64s("nestExtent").filter(|v| v.len() == 4).ok_or("missing local extent")?;
                        let geography = nest::Geography { bounds: [bounds[0], bounds[1], bounds[2], bounds[3]], extent: [extent[0], extent[1], extent[2], extent[3]], zone: if b.num("nestZone").is_finite() { b.num("nestZone") as i32 } else { 56 } };
                        let tuning = nest::Tuning { per_edge: 16, margin: None, ramp: None };
                        let plan = nest::plan_geographic(&parent, &solver, &geography, &sea, &tuning)?;
                        let source = b.f64s("coupleSource").filter(|v| v.len() == 2).unwrap_or_else(|| vec![0.0, 0.0]);
                        let seconds = if b.num("coupleSeconds").is_finite() { b.num("coupleSeconds") } else { coupling::parent_seconds(&plan, parent.cell, (source[0], source[1]), local_seconds, 120.0, 120.0) };
                        // members of an ensemble that differ only in local settings share one regional run
                        let key = b.u8s("cacheKey").unwrap_or_default();
                        let cached = RECORDINGS.with(|c| c.borrow().get(&key).cloned());
                        let hit = cached.is_some() && !key.is_empty();
                        o.num("regionalCached", if hit { 1.0 } else { 0.0 });
                        let (recording, regional_peak) = match cached.filter(|_| !key.is_empty()) {
                            Some(hit) => hit,
                            None => {
                                if seconds / parent.dt > 40_000.0 { return Err("parent run needs too many steps".into()); }
                                parent.record(&plan.points.iter().map(|p| (p.0, p.1)).collect::<Vec<_>>())?;
                                while parent.time < seconds { parent.advance(200)?; }
                                let r = parent.recorded().ok_or("no recording")?;
                                let made = (coupling::Recording { times: r.times.clone(), values: r.values.clone(), points: r.points }, parent.peak.iter().fold(0.0_f64, |m, v| m.max(*v)));
                                if !key.is_empty() { RECORDINGS.with(|c| { let mut c = c.borrow_mut(); if c.len() >= 8 { c.clear(); } c.insert(key.clone(), made.clone()); }); }
                                made
                            }
                        };
                        o.num("regionalSeconds", seconds).num("regionalPeak", regional_peak).num("snapped", plan.snapped as f64);
                        coupling::forcing_from_recording(&plan, &recording, 120.0, 0.02, local_seconds)?
                    };
                    for e in &forcing.edges { solver.set_forcing(e.edge, forcing.times.clone(), e.series.clone(), e.points)?; }
                    // arrival times count from when the wave reached the model's edge, in the local clock
                    TSUNAMI_LAND.with(|l| { let mut l = l.borrow_mut(); if !b.num("arrivalOrigin").is_finite() && forcing.arrival.is_finite() { l.1 = forcing.arrival - forcing.offset; } });
                    let codes: Vec<f64> = forcing.edges.iter().map(|e| match e.edge { inundation::Edge::North => 0.0, inundation::Edge::East => 1.0, inundation::Edge::South => 2.0, inundation::Edge::West => 3.0 }).collect();
                    o.num("coupled", b.num("couple")).num("arrival", forcing.arrival).num("offset", forcing.offset).num("peak", forcing.peak).num("rows", forcing.times.len() as f64)
                        .f64s("edgeCodes", &codes).f64s("edgePeak", &forcing.edges.iter().map(|e| e.peak).collect::<Vec<_>>())
                        .f64s("edgePoints", &forcing.edges.iter().map(|e| e.points as f64).collect::<Vec<_>>()).f64s("edgeSnapped", &forcing.edges.iter().map(|e| e.snapped as f64).collect::<Vec<_>>());
                    if let Some(end) = solver.forcing_end() { o.num("forcingEnd", end); }
                    o.num("dt", solver.dt);
                    INUNDATION.with(|s| *s.borrow_mut() = Some(solver));
                } else {
                    if let Some(end) = solver.forcing_end() { o.num("forcingEnd", end); }
                    o.num("dt", solver.dt);
                    INUNDATION.with(|s| *s.borrow_mut() = Some(solver));
                }
            } else {
                let mut solver = tsunami::Solver::new(
                    b.num("W") as usize, b.num("H") as usize, b.num("cell"),
                    b.f64s("depth").ok_or("missing ocean depths")?,
                    b.f64s("eta").ok_or("missing initial wave")?, b.num("absorbing") == 1.0,
                )?;
                if b.num("method") == 1.0 { solver.method = tsunami::Method::FiniteVolume; }
                if b.num("method") == 3.0 { solver.method = tsunami::Method::Dispersive; solver.advance(0)?; }
                o.num("dt", solver.dt);
                TSUNAMI.with(|s| *s.borrow_mut() = Some(solver));
            }
        }
        "tsunamiParent" => {
            // Run a regional propagation model to completion without keeping
            // it, recording eta at the requested points (x, y pairs in cell
            // coordinates) as boundary forcing for a nested local model.
            let seconds = b.num("seconds");
            if !seconds.is_finite() || seconds <= 0.0 || seconds > 21_600.0 { return Err("invalid parent run length".into()); }
            let xy = b.f64s("points").ok_or("missing recording points")?;
            if xy.len() % 2 != 0 { return Err("recording points must be x, y pairs".into()); }
            let points: Vec<(f64, f64)> = xy.chunks(2).map(|p| (p[0], p[1])).collect();
            let mut solver = tsunami::Solver::new(
                b.num("W") as usize, b.num("H") as usize, b.num("cell"),
                b.f64s("depth").ok_or("missing ocean depths")?,
                b.f64s("eta").ok_or("missing initial wave")?, b.num("absorbing") == 1.0,
            )?;
            if b.num("method") == 1.0 { solver.method = tsunami::Method::FiniteVolume; }
            if b.num("method") == 3.0 { solver.method = tsunami::Method::Dispersive; solver.advance(0)?; }
            if (seconds / solver.dt) > 40_000.0 { return Err("parent run needs too many steps".into()); }
            solver.record(&points)?;
            while solver.time < seconds { solver.advance(200)?; }
            let r = solver.recorded().ok_or("no recording")?;
            o.num("dt", solver.dt).num("time", solver.time).num("points", r.points as f64);
            o.f64s("times", &r.times).f64s("values", &r.values);
            o.f32s("peak", &solver.peak.iter().map(|v| *v as f32).collect::<Vec<_>>());
        }
        "tsunamiStep" => {
            let steps = b.num("steps");
            if !steps.is_finite() || !(0.0..=200.0).contains(&steps) || steps.fract() != 0.0 {
                return Err("invalid tsunami step count".into());
            }
            let nested = NEST.with(|slot| -> Result<bool, String> {
                let mut slot = slot.borrow_mut();
                let Some(n) = slot.as_mut() else { return Ok(false); };
                n.advance(steps as usize)?;
                let s = &n.child;
                o.num("time", s.time).num("dt", s.dt).num("volume", s.volume())
                    .num("volumeError", s.volume_error()).num("boundaryVolume", s.boundary_volume).num("feedbackVolume", n.feedback_volume);
                inundation_frame(&mut o, s, b.num("extremes") == 1.0);
                o.f32s("parentEta", &n.parent.eta.iter().map(|v| *v as f32).collect::<Vec<_>>());
                Ok(true)
            })?;
            let nested3 = !nested && NEST3.with(|slot| -> Result<bool, String> {
                let mut slot = slot.borrow_mut();
                let Some(n) = slot.as_mut() else { return Ok(false); };
                n.advance(steps as usize)?;
                let s = &n.child;
                o.num("time", s.time).num("dt", s.dt).num("volume", s.volume())
                    .num("volumeError", s.volume_error()).num("boundaryVolume", s.boundary_volume).num("feedbackVolume", n.feedback_volume + n.parent.feedback_volume);
                inundation_frame(&mut o, s, b.num("extremes") == 1.0);
                o.f32s("parentEta", &n.parent.parent.eta.iter().map(|v| *v as f32).collect::<Vec<_>>());
                Ok(true)
            })?;
            let nonlinear = nested || nested3 || INUNDATION.with(|slot| -> Result<bool, String> {
                let mut slot = slot.borrow_mut();
                let Some(s) = slot.as_mut() else { return Ok(false); };
                s.advance(steps as usize)?;
                o.num("time", s.time).num("dt", s.dt).num("volume", s.volume())
                    .num("volumeError", s.volume_error()).num("boundaryVolume", s.boundary_volume);
                inundation_frame(&mut o, s, b.num("extremes") == 1.0);
                Ok(true)
            })?;
            if !nonlinear {
                TSUNAMI.with(|slot| -> Result<(), String> {
                    let mut slot = slot.borrow_mut();
                    let s = slot.as_mut().ok_or("no active tsunami simulation")?;
                    s.advance(steps as usize)?;
                    o.num("time", s.time).num("dt", s.dt).num("volume", s.volume());
                    o.f32s("eta", &s.eta.iter().map(|v| *v as f32).collect::<Vec<_>>());
                    o.f32s("peak", &s.peak.iter().map(|v| *v as f32).collect::<Vec<_>>());
                    Ok(())
                })?;
            }
        }
        "inertialPrepare" => {
            // the area model's terrain averaged into blocks the 2D solver can take (see inertial_grid.rs)
            let a = area_of(b)?;
            let g = inertial_grid::prepare(&a, b.num("maxSide") as usize)?;
            o.num("W", g.w as f64).num("H", g.h as f64).num("cell", g.cell).num("factor", g.factor as f64).f64s("dem", &g.dem).u8s("valid", &g.valid).u8s("ocean", &g.ocean);
        }
        "inertialCell" => {
            let a = area_of(b)?;
            let g = prepared_of(b)?;
            o.num("index", inertial_grid::cell_of(&g, &a, b.num("i") as i64).map_or(-1.0, |c| c as f64));
        }
        "inertialExpand" => {
            // the solver's answer spread over the area model's cells; `peak` shows the deepest water instead of the final depth
            let a = area_of(b)?;
            let g = prepared_of(b)?;
            let n = g.w * g.h;
            let field = |k: &str| -> Result<Option<Vec<f64>>, String> { match b.f64s(k) { Some(v) if v.len() == n => Ok(Some(v)), Some(_) => Err(format!("the solver's {k} does not match its grid")), None => Ok(None) } };
            let (depth, peak, vx, vy, class, speed, arrival) = (field("depth")?.ok_or("missing depths")?, field("peak")?, field("vx")?, field("vy")?, field("peakClass")?, field("peakSpeed")?, field("arrival")?);
            let e = inertial_grid::expand(&a, &g, &inertial_grid::SolverResult { depth: &depth, peak: peak.as_deref(), vx: vx.as_deref(), vy: vy.as_deref(), peak_class: class.as_deref(), peak_speed: speed.as_deref(), arrival: arrival.as_deref() }, b.num("peakMode") == 1.0);
            o.f32s("depth", &e.depth).u8s("wet", &e.wet).f32s("level", &e.level).f64s("vx", &e.vx).f64s("vy", &e.vy);
            if let Some(t) = &e.arrival { o.f32s("arrival", t); }
            if let Some(hz) = &e.hazard { o.u8s("cls", &hz.class).f32s("vel", &hz.speed).f64s("km2", &hz.km2); }
        }
        "effectiveRainSeries" => {
            // a storm's rain less its initial and continuing losses, in short steps, for the 2D solver (see flash.rs)
            let optional = |k: &str, default: f64| { let v = b.num(k); if v.is_finite() { v } else { default } };
            let r = flash::effective_rain_series(b.num("rainMm"), b.num("hours"), b.num("initialLoss"), b.num("contLoss"), optional("afterHours", 2.0), optional("stepSeconds", flash::STEP_SECONDS))?;
            o.f64s("series", &r.series).num("seconds", r.seconds).num("stepSeconds", r.step_seconds).num("stormHours", r.storm_hours).num("rainMm", r.rain_mm)
                .num("effectiveMm", r.effective_mm).num("capped", if r.capped { 1.0 } else { 0.0 });
        }
        "tsunamiGrid" => {
            // a grid for the tsunami lab, built and checked in Rust (tsunami_grid.rs): kind 0 regional, 1 idealised estuary, 2 local terrain scene
            let source = b.f64s("source").filter(|v| v.len() == 2).map_or([f64::NAN, f64::NAN], |v| [v[0], v[1]]);
            let (amplitude, width, absorbing) = (b.num("amplitude"), b.num("width"), b.num("absorbing") == 1.0);
            let elevation = b.f64s("elevation").unwrap_or_default();
            let grid = match b.num("kind") as i64 {
                0 => {
                    let bounds = b.f64s("bounds").unwrap_or_default();
                    let basin = if b.num("coast") == 1.0 {
                        tsunami_grid::Basin::Coast { id_ok: b.num("idOk") == 1.0, w: b.num("bW") as usize, h: b.num("bH") as usize, cell: b.num("bCell"), elevation: &elevation, bounds: &bounds }
                    } else {
                        tsunami_grid::Basin::Ideal(match b.num("shape") as i64 { 0 => tsunami_grid::Shape::Flat, 2 => tsunami_grid::Shape::Island, _ => tsunami_grid::Shape::Shelf })
                    };
                    tsunami_grid::regional(&tsunami_grid::Regional { basin, deep: b.num("deep"), amplitude, width, source, absorbing, method: if b.num("method").is_finite() { b.num("method") as u8 } else { 255 } })?
                }
                1 => tsunami_grid::estuary(&tsunami_grid::Estuary { amplitude, width, source, absorbing, tide: b.num("tide"), roughness: b.num("roughness"), lake_level: b.num("lakeLevel") })?,
                _ => {
                    let valid = b.u8s("valid");
                    let extent = b.f64s("extent").unwrap_or_default();
                    let sea: Vec<inundation::Edge> = b.f64s("seaEdges").unwrap_or_default().iter().filter_map(|c| inundation::Edge::from_code(*c as usize)).collect();
                    tsunami_grid::local(&tsunami_grid::Local {
                        terrain: tsunami_grid::LocalTerrain { id_ok: b.num("idOk") == 1.0, w: b.num("bW") as usize, h: b.num("bH") as usize, cell: b.num("bCell"), valid: valid.as_deref(), elevation: &elevation, extent: &extent, sea_edges: &sea },
                        amplitude, width, source, absorbing, tide: b.num("tide"), roughness: b.num("roughness"), coupled: b.num("coupled") == 1.0,
                    })?
                }
            };
            o.num("W", grid.w as f64).num("H", grid.h as f64).num("cell", grid.cell).f64s("depth", &grid.depth).f64s("eta", &grid.eta).num("absorbing", f64::from(grid.absorbing))
                .num("method", f64::from(grid.method)).num("coupled", f64::from(grid.coupled));
            if let Some(bed) = &grid.bed { o.f64s("bed", bed); }
            if let Some(valid) = &grid.valid { o.u8s("valid", valid); }
            if let Some(r) = grid.roughness { o.num("roughness", r); }
        }
        "connectedWaterDepth" => {
            // the sea filled inward from a scene's open edges (see tsunami_grid.rs)
            let (w, h) = (b.num("W") as usize, b.num("H") as usize);
            let bed = b.f64s("bed").ok_or("missing bed")?;
            if w == 0 || h == 0 || bed.len() != w * h { return Err("the bed does not match the grid".into()); }
            let valid = b.u8s("valid");
            if valid.as_ref().is_some_and(|v| v.len() != bed.len()) { return Err("the mask does not match the grid".into()); }
            let edges: Vec<inundation::Edge> = b.f64s("edges").unwrap_or_default().iter().filter_map(|c| inundation::Edge::from_code(*c as usize)).collect();
            o.f64s("depth", &tsunami_grid::connected_water_depth(&bed, w, h, b.num("level"), &edges, valid.as_deref())?);
        }
        "ensemblePlan" => {
            // the runs of a sensitivity ensemble (see ensemble.rs): kind 0 base, 1 low, 2 high, 3 severe, 4 mild; input 0..3 amplitude, tide, roughness, terrain (-1 when none)
            let d = ensemble::Spread::default();
            let or = |k: &str, v: f64| if b.num(k).is_finite() { b.num(k) } else { v };
            let spread = ensemble::Spread { amplitude_percent: or("amplitudePercent", d.amplitude_percent), tide_metres: or("tideMetres", d.tide_metres), roughness_percent: or("roughnessPercent", d.roughness_percent), terrain_metres: or("terrainMetres", d.terrain_metres) };
            let base = ensemble::Factors { amplitude: b.num("amplitude"), tide: b.num("tide"), roughness: b.num("roughness"), terrain: 0.0 };
            let members = ensemble::plan(base, &spread, b.num("terrain") != 0.0, b.num("varyAmplitude") != 0.0);
            let code = |i: ensemble::Input| ensemble::INPUTS.iter().position(|x| *x == i).unwrap() as i32;
            let (mut kind, mut input, mut factors) = (Vec::new(), Vec::new(), Vec::new());
            for m in &members {
                let (k, i) = match m.kind { ensemble::Kind::Base => (0, -1), ensemble::Kind::Low(i) => (1, code(i)), ensemble::Kind::High(i) => (2, code(i)), ensemble::Kind::Severe => (3, -1), ensemble::Kind::Mild => (4, -1) };
                kind.push(k); input.push(i);
                factors.extend([m.factors.amplitude, m.factors.tide, m.factors.roughness, m.factors.terrain]);
            }
            o.i32s("kind", &kind).i32s("input", &input).f64s("factors", &factors);
        }
        "encodeRates" => {
            // hazard rates per year to the stored one-byte codes (see codec.rs)
            let r = b.f64s("rates").ok_or("missing rates")?;
            o.u8s("codes", &r.iter().map(|v| codec::encode_rate(*v)).collect::<Vec<_>>());
        }
        "decodeRates" => {
            // stored codes to rates per year, and to the hazard class of each (-1 not drawn)
            let c = b.u8s("codes").ok_or("missing codes")?;
            let rates: Vec<f64> = c.iter().map(|v| codec::decode_rate(*v)).collect();
            o.i32s("classes", &rates.iter().map(|r| codec::class_of_rate(*r)).collect::<Vec<_>>()).f64s("rates", &rates);
        }
        "classOfRates" => {
            let r = b.f64s("rates").ok_or("missing rates")?;
            o.i32s("classes", &r.iter().map(|v| codec::class_of_rate(*v)).collect::<Vec<_>>());
        }
        "terrarium" => {
            let rgba = b.u8s("rgba").ok_or("missing rgba")?;
            let n = b.num("n") as usize;
            if rgba.len() < n * n * 4 { return Err("tile has fewer pixels than n x n".into()); }
            o.f32s("heights", &codec::decode_terrarium(&rgba, n));
        }
        "waterPoint" => {
            // the ocean cell nearest a target (see lab.rs); x and y are -1 when no cell is deep enough
            let z = b.f64s("elevation").ok_or("missing elevation")?;
            let p = lab::water_point(&z, b.num("width") as usize, (b.num("targetX"), b.num("targetY")), b.num("minDepth"));
            o.num("x", p.map_or(-1.0, |p| p.0 as f64)).num("y", p.map_or(-1.0, |p| p.1 as f64));
        }
        "frameStats" => {
            // what a frame has flooded and its extremes (see lab.rs)
            let get = |k: &str| b.f64s(k).unwrap_or_default();
            let s = lab::frame_stats(&get("depth"), &get("water"), &get("speed"), &get("peak"));
            o.num("flooded", s.flooded as f64).num("maxLandDepth", s.max_land_depth).num("maxSpeed", s.max_speed).num("maxPeak", s.max_peak);
        }
        "terrainColours" => {
            // display heights and colours of a grid's ground (see lab.rs); NaN marks unknown heights
            let t = lab::terrain(b.f64s("elevation").ok_or("missing elevation")?, b.u8s("valid").as_deref());
            o.f64s("elevation", &t.elevation).num("low", t.low).num("high", t.high).u8s("colours", &t.colours);
        }
        "spans" => {
            // minimum, maximum and count of non-finite values for each of `columns` columns of run-major values
            let values = b.f64s("values").ok_or("missing values")?;
            let columns = b.num("columns") as usize;
            if columns == 0 || values.len() % columns != 0 { return Err("values do not fill the columns".into()); }
            let spans: Vec<ensemble::Span> = (0..columns).map(|c| ensemble::span(values.iter().skip(c).step_by(columns).copied())).collect();
            o.f64s("min", &spans.iter().map(|s| s.min).collect::<Vec<_>>()).f64s("max", &spans.iter().map(|s| s.max).collect::<Vec<_>>()).i32s("missing", &spans.iter().map(|s| s.missing as i32).collect::<Vec<_>>());
        }
        "parseSeries" => {
            // a wave series file's text (UTF-8 bytes) to seconds and metres (see series.rs)
            let bytes = b.u8s("text").ok_or("missing text")?;
            let max_rows = if b.num("maxRows").is_finite() { b.num("maxRows") as usize } else { series::MAX_ROWS };
            let (times, values) = series::parse_series_csv(&String::from_utf8_lossy(&bytes), max_rows)?;
            o.f64s("times", &times).f64s("values", &values);
        }
        "tsunamiBounds" => {
            // [south, west, north, east] of a place's four corners, degrees
            // (a place's grid size is not needed for its bounds, so the bare locations list works too)
            let extent = b.f64s("placeExtent").filter(|v| v.len() == 4).ok_or("missing place extent")?;
            let zone = if b.num("placeZone").is_finite() { b.num("placeZone") as i32 } else { 56 };
            o.f64s("bounds", &place::bounds(&place::Place { extent: [extent[0], extent[1], extent[2], extent[3]], w: 1, h: 1, zone }));
        }
        "mga" => {
            // latitude and longitude to MGA easting and northing (mode 0) or back (mode 1), in bulk, for one zone
            let zone = if b.num("zone").is_finite() { b.num("zone") as i32 } else { 56 };
            let (first, second) = (b.f64s("a").ok_or("missing coordinates")?, b.f64s("b").ok_or("missing coordinates")?);
            if first.len() != second.len() { return Err("the coordinate lists differ in length".into()); }
            let out: Vec<(f64, f64)> = first.iter().zip(&second).map(|(p, q)| if b.num("mode") == 1.0 { geo::from_mga(*p, *q, zone) } else { geo::to_mga(*p, *q, zone) }).collect();
            o.f64s("a", &out.iter().map(|c| c.0).collect::<Vec<_>>()).f64s("b", &out.iter().map(|c| c.1).collect::<Vec<_>>());
        }
        "tsunamiCell" => {
            // the grid cell of a place under a latitude and longitude, or -1
            let p = place_of(b, "place")?;
            o.num("index", place::cell_index(&p, b.num("lat"), b.num("lon")).map_or(-1.0, |c| c as f64));
        }
        "tsunamiPixelMap" => {
            // the grid cell under every pixel of a canvas laid over [south, west, north, east], row 0 the north edge (-1 outside the place)
            let p = place_of(b, "place")?;
            let over = b.f64s("over").filter(|v| v.len() == 4).ok_or("missing canvas bounds")?;
            let (width, height) = (b.num("width"), b.num("height"));
            if !(width >= 1.0 && height >= 1.0 && width * height <= 16_000_000.0) { return Err("invalid canvas size".into()); }
            o.i32s("map", &place::pixel_map(&p, [over[0], over[1], over[2], over[3]], width as usize, height as usize));
        }
        "tsunamiToArea" => {
            // a tsunami run's extremes on an area model's cells (see place.rs)
            let p = place_of(b, "place")?;
            let (w, h) = (b.num("W") as usize, b.num("H") as usize);
            let dem = b.f64s("dem").ok_or("missing elevations")?;
            if w == 0 || dem.len() != w * h { return Err("the elevations do not match the grid".into()); }
            let (valid, ocean) = (b.u8s("valid").unwrap_or_default(), b.u8s("ocean").unwrap_or_default());
            if (!valid.is_empty() && valid.len() != dem.len()) || (!ocean.is_empty() && ocean.len() != dem.len()) { return Err("the masks do not match the grid".into()); }
            let area = dam::Area { w, h, cell: b.num("cell"), dem, valid, ocean };
            let over = b.f64s("geo").filter(|v| v.len() == 4).ok_or("missing area bounds")?;
            let (land, peak, arrival, class, speed) = (b.u8s("land").ok_or("missing land mask")?, b.f64s("peak").ok_or("missing peaks")?, b.f64s("arrival").ok_or("missing arrivals")?, b.u8s("cls").ok_or("missing classes")?, b.f64s("vel").ok_or("missing speeds")?);
            let n = p.w * p.h;
            if [land.len(), peak.len(), arrival.len(), class.len(), speed.len()].iter().any(|l| *l != n) { return Err("the run does not match the place grid".into()); }
            let r = place::run_on_area(&area, [over[0], over[1], over[2], over[3]], &p, &place::Derived { land: &land, peak: &peak, arrival: &arrival, class: &class, speed: &speed });
            o.f32s("depth", &r.depth).u8s("wet", &r.wet).f32s("level", &r.level).f32s("arrival", &r.arrival).u8s("cls", &r.class).f32s("vel", &r.speed).f64s("km2", &r.km2).num("covered", r.covered as f64);
        }
        "damStart" => {
            // A dam failure on an area model: plan the window, breach and reservoir, and start the solver (see dam.rs).
            DAM.with(|s| *s.borrow_mut() = None);
            let (w, h) = (b.num("W") as usize, b.num("H") as usize);
            let dem = b.f64s("dem").ok_or("missing elevations")?;
            let indices = |k: &str| b.f64s(k).unwrap_or_default().iter().map(|c| *c as usize).collect::<Vec<_>>();
            if dem.len() != w.checked_mul(h).ok_or("grid overflow")? || w == 0 { return Err("the elevations do not match the grid".into()); }
            let (valid, ocean) = (b.u8s("valid").unwrap_or_default(), b.u8s("ocean").unwrap_or_default());
            if (!valid.is_empty() && valid.len() != dem.len()) || (!ocean.is_empty() && ocean.len() != dem.len()) { return Err("the masks do not match the grid".into()); }
            let area = dam::Area { w, h, cell: b.num("cell"), dem, valid, ocean };
            let params = dam::Params {
                gauge: b.num("gauge") as usize, crest: b.num("crest") as usize, below: b.num("below") as usize, lake: b.num("lake"),
                route: indices("route"), downstream: indices("downstream"), volume: b.num("volume"), mode: dam::Mode::from_code(b.num("mode")),
                time_scale: if b.num("timeScale").is_finite() { b.num("timeScale") } else { 1.0 },
            };
            let run = dam::Run::start(area, &params)?;
            let p = &run.plan;
            o.num("W", p.w as f64).num("H", p.h as f64).num("cell", p.cell).num("factor", p.factor as f64).num("volume", p.volume).num("requested", p.requested)
                .num("depth", p.depth).num("wallHeight", p.wall_height).num("reservoirCells", p.reservoir_cells as f64).num("breachWidth", p.froehlich.width)
                .num("breachSeconds", p.breach_seconds).num("breachStart", p.breach_start).num("froehlichPeak", p.froehlich.peak).num("breachCells", p.breach_cells.len() as f64)
                .num("seconds", p.seconds).num("dt", run.solver.dt);
            DAM.with(|s| *s.borrow_mut() = Some(run));
        }
        "damStep" => {
            let steps = b.num("steps");
            if !steps.is_finite() || !(0.0..=200.0).contains(&steps) || steps.fract() != 0.0 { return Err("invalid dam-break step count".into()); }
            DAM.with(|slot| -> Result<(), String> {
                let mut slot = slot.borrow_mut();
                let run = slot.as_mut().ok_or("no active dam-break run")?;
                run.advance(steps as usize)?;
                o.num("time", run.solver.time).num("dt", run.solver.dt).num("volumeError", run.solver.volume_error()).num("discharge", run.discharge())
                    .num("peakDischarge", run.peak_discharge).num("peakDischargeAt", run.peak_discharge_at);
                Ok(())
            })?;
        }
        "damFinish" => {
            DAM.with(|slot| -> Result<(), String> {
                let slot = slot.borrow();
                let run = slot.as_ref().ok_or("no active dam-break run")?;
                let r = run.finish();
                o.f32s("depth", &r.depth).u8s("wet", &r.wet).f32s("level", &r.level).f32s("arrival", &r.arrival).u8s("cls", &r.class).f32s("vel", &r.speed)
                    .f64s("km2", &r.km2).num("covered", r.covered as f64).num("edge", if r.edge { 1.0 } else { 0.0 });
                Ok(())
            })?;
        }
        "inertialStart" => {
            // One simulation per dedicated worker/module instance.
            INERTIAL.with(|s| *s.borrow_mut() = None);
            let grid = grid_of(b)?;
            let stages = b.f64s("stages").unwrap_or_else(|| vec![f64::NAN; grid.w * grid.h]);
            let inflow = b.num("inflowCell");
            let solver = inertial::Solver::new(grid, inertial::Options {
                seconds: b.num("seconds"), rain_mm_h: b.num("rainMmH"),
                roughness: b.num("roughness"), initial_depth: b.num("initialDepth"),
                inflow_cell: if inflow.is_finite() && inflow >= 0.0 {Some(inflow as usize)} else {None},
                inflow_m3_s: b.num("inflow"), inflow_series: b.f64s("inflowSeries"),
                rain_series: b.f64s("rainSeries"),
                series_step_s: b.num("seriesStepS"), arrival_depth: b.num("arrivalDepth"),
                stages,
            })?;
            INERTIAL.with(|s| *s.borrow_mut() = Some(solver));
        }
        "inertialStep" => {
            INERTIAL.with(|slot| -> Result<(), String> {
                let mut slot = slot.borrow_mut();
                let s = slot.as_mut().ok_or("no active 2D simulation")?;
                s.advance(8)?;
                let done = s.time >= s.opts.seconds;
                o.num("time", s.time).num("done", if done {1.0} else {0.0})
                    .num("steps", s.steps as f64).num("volume", s.volume())
                    .num("initialVolume", s.initial_volume).num("sourceVolume", s.source_volume)
                    .num("boundaryVolume", s.boundary_volume).num("balanceError", s.balance_error());
                if done {
                    o.f64s("depth", &s.depth);
                    o.f64s("vx", &s.vx);
                    o.f64s("vy", &s.vy);
                    o.f64s("peak", &s.peak);
                    o.f64s("peakSpeed", &s.peak_speed);
                    o.f64s("peakClass", &s.peak_class.iter().map(|c| *c as f64).collect::<Vec<_>>());
                    o.f64s("arrival", &s.arrival);
                    *slot = None;
                }
                Ok(())
            })?;
        }
        "inertialVelocities" => {
            INERTIAL.with(|slot| -> Result<(), String> {
                let slot = slot.borrow();
                let s = slot.as_ref().ok_or("no active 2D simulation")?;
                o.f64s("vx", &s.vx).f64s("vy", &s.vy);
                Ok(())
            })?;
        }
        "analyse" => {
            let g = grid_of(b)?;
            let a = analyse(&g, flood_core::util::nullish(b.num("streamAreaKm2"), 4.0));
            put_analysis(&mut o, &a);
            let h = ANALYSES.with(|s| store(s, a));
            o.num("handle", h as f64);
        }
        "load" => {
            let a = load_analysis(b)?;
            let h = ANALYSES.with(|s| store(s, a));
            o.num("handle", h as f64);
        }
        "drop" => {
            let h = b.num("a");
            ANALYSES.with(|s| {
                if let Some(x) = s.borrow_mut().get_mut(h as usize) {
                    *x = None;
                }
            });
        }
        "dropWave" => {
            let h = b.num("w");
            WAVES.with(|s| {
                if let Some(x) = s.borrow_mut().get_mut(h as usize) {
                    *x = None;
                }
            });
        }
        "streamSurface" => {
            let s = scenario_of(b);
            let (wse, on_path) = with_analysis(b.num("a"), |a| stream_surface(a, &s))?;
            o.f64s("wse", &wse).u8s("onPath", &on_path);
        }
        "composeWater" => {
            let w = b.num("w") as usize;
            let h = b.num("h") as usize;
            let relief = b.num("relief") != 0.0;
            let mode = b.num("mode") as u8;
            let flood_a = b.num("floodA") as u8;
            let stream_a = b.num("streamA") as u8;
            let cell_km2 = b.num("cellKm2") as f32;
            let stream_thr = b.num("streamThr") as f32;
            let valid = b.u8s("valid").unwrap_or_default();
            let ocean = b.u8s("ocean").unwrap_or_default();
            let stream = b.u8s("stream").unwrap_or_default();
            let acc = b.f32s("acc").unwrap_or_default();
            let sat = b.f32s("sat").unwrap_or_default();
            let base_wet = b.u8s("baseWet").unwrap_or_default();
            let run_wet = b.u8s("runWet").unwrap_or_default();
            let run_depth = b.f32s("runDepth").unwrap_or_default();
            let hz_cls = b.u8s("hzCls").unwrap_or_default();
            let cmp_diff = b.i32s("cmpDiff").unwrap_or_default();
            let cmp_diff: Vec<i8> = cmp_diff.iter().map(|&x| x as i8).collect();
            let mask = b.u8s("mask");
            let params = flood_core::render::ComposeParams {
                w, h, relief, mode, flood_a, stream_a, cell_km2, stream_thr,
            };
            let (rgba, count) = flood_core::render::compose_water(
                &valid, &ocean, &stream, &acc, &sat, &base_wet, &run_wet,
                &run_depth, &hz_cls, &cmp_diff, &params, mask.as_deref(),
            );
            o.u8s("rgba", &rgba).num("count", count as f64);
        }
        "inundate" => {
            let s = scenario_of(b);
            let slim = b.has("slim");
            let r = with_analysis(b.num("a"), |a| inundate(a, &s))?;
            put_run(&mut o, &r, slim);
        }
        "waterMesh" => {
            let (col_x, row_z) = (b.f64s("colX").unwrap_or_default(), b.f64s("rowZ").unwrap_or_default());
            let (surface, depth, wet) = (b.f64s("surface").unwrap_or_default(), b.f32s("depth").unwrap_or_default(), b.u8s("wet").unwrap_or_default());
            let (dem, frame) = (b.f32s("dem").unwrap_or_default(), b.u8s("frame").unwrap_or_default());
            let water = if b.has("frame") {
                mesh::Water::Frame { dem: &dem, frame: &frame, max_d: b.num("maxD") }
            } else {
                mesh::Water::Run { surface: &surface, depth: &depth, wet: &wet }
            };
            let m = mesh::water_mesh(&mesh::MeshIn {
                w: b.num("W") as usize, h: b.num("H") as usize, cell: b.num("cell"), skip: b.num("skip") as usize, lift: b.num("lift"),
                soft: b.num("soft") != 0.0, col_x: &col_x, row_z: &row_z, water,
            });
            match m {
                Some(m) => { o.num("any", 1.0).f32s("positions", &m.positions).f32s("colors", &m.colors).f32s("uvs", &m.uvs).u32s("indices", &m.indices); }
                None => { o.num("any", 0.0); }
            }
        }
        "polygonMask" => {
            let (coords, off) = (b.f64s("pts").unwrap_or_default(), b.i32s("off").unwrap_or_default());
            let rings: Vec<Vec<(f64, f64)>> = off.windows(2).map(|w| coords[2 * w[0] as usize..2 * w[1] as usize].chunks(2).map(|p| (p[0], p[1])).collect()).collect();
            let geo = impact::Geo { west: b.num("west"), east: b.num("east"), south: b.num("south"), north: b.num("north"), w: b.num("W") as usize, h: b.num("H") as usize };
            o.u8s("mask", &impact::polygon_mask(&geo, &rings));
        }
        "netLoad" => {
            let (g, f) = (|k: &str| b.i32s(k).unwrap_or_default(), |k: &str| b.f64s(k).unwrap_or_default());
            let n = net::Net::new(f("lat"), f("lon"), g("eu"), g("ev"), g("eroad"), f("centreLat"), f("centreLon"));
            let h = NETS.with(|s| store(s, n));
            o.num("handle", h as f64);
        }
        "netDrop" => {
            let h = b.num("net");
            NETS.with(|s| { if let Some(x) = s.borrow_mut().get_mut(h as usize) { *x = None; } });
        }
        "netGrid" => {
            let geo = impact::Geo { west: b.num("west"), east: b.num("east"), south: b.num("south"), north: b.num("north"), w: b.num("W") as usize, h: b.num("H") as usize };
            with_net(b.num("net"), |n| n.set_grid(geo))?;
        }
        "netBuildings" => {
            let (bx, by) = (b.f64s("bx").unwrap_or_default(), b.f64s("by").unwrap_or_default());
            with_net(b.num("net"), |n| n.set_buildings(&bx, &by, b.u8s("isHome").unwrap_or_default(), b.u8s("isWork").unwrap_or_default()))??;
        }
        "netCensus" => {
            let g = |k: &str| b.i32s(k).unwrap_or_default();
            let f = |k: &str| b.f64s(k).unwrap_or_default();
            let ocean = b.u8s("ocean").unwrap_or_default();
            with_net(b.num("net"), |n| n.set_census(g("sa1Grid"), b.num("nSa1") as usize, g("sa2Grid"), b.num("nSa2") as usize, &ocean, b.num("cellKm2"), (f("roadLat"), f("roadLon"), g("roadOff"))))?;
        }
        "netRun" => {
            with_net(b.num("net"), |n| n.set_run(b.u8s("wet").unwrap_or_default(), b.f32s("depth").unwrap_or_default(), b.u8s("ocean").unwrap_or_default()))??;
        }
        "netRoute" => {
            let r = with_net(b.num("net"), |n| n.route(b.num("lat"), b.num("lon")))??;
            let none = |p: &Option<net::Path>| p.is_none() as u8 as f64;
            o.num("none", r.none as u8 as f64).num("startKm", r.start_km).num("centres", r.centres as f64).num("centresFlooded", r.centres_flooded as f64).num("centre", r.centre as f64);
            o.num("noExit", none(&r.to_exit)).num("noCentre", none(&r.to_centre));
            if let Some(p) = &r.to_exit { o.num("exitKm", p.km).i32s("exitNodes", &p.nodes).i32s("exitVias", &p.vias); }
            if let Some(p) = &r.to_centre { o.num("centreKm", p.km).i32s("centreNodes", &p.nodes).i32s("centreVias", &p.vias); }
        }
        "netImpact" => {
            let r = with_net(b.num("net"), |n| -> Result<impact::ImpactOut, String> {
                let (g, bl, run) = (n.grid.as_ref().ok_or("the grid is not set")?, n.buildings.as_ref().ok_or("the buildings are not set")?, n.run.as_ref().ok_or("no run is set")?);
                // each census area's share inside the model (population and workers, scaled by how much of it is covered)
                let share = |raw: Vec<f64>, km2: Vec<f64>, inside: &[f64]| -> Vec<f64> {
                    (0..raw.len()).map(|s| raw[s] * if km2[s] > 0.0 { (inside[s] / km2[s]).min(1.0) } else { 0.0 }).collect()
                };
                let sa1_pop = share(b.f64s("sa1Pop").unwrap_or_default(), b.f64s("sa1Km2").unwrap_or_default(), &n.census.sa1_inside);
                let sa2_workers = share(b.f64s("sa2Workers").unwrap_or_default(), b.f64s("sa2Km2").unwrap_or_default(), &n.census.sa2_inside);
                Ok(impact::impact_sweep(&impact::ImpactIn {
                    geo: g.geo, cell_m: b.num("cellM"), wet: &run.wet, depth: &run.depth, ocean: &run.ocean,
                    b_cell: &bl.b_cell, is_home: &bl.is_home, is_work: &bl.is_work, b_node: &bl.b_node,
                    off: &n.off, to: &n.to, edge: &n.edge, edge_u: &n.edge_u, edge_v: &n.edge_v, exit: &g.exit, dry_reach: &g.dry_reach,
                    closed: &run.roads.closed, road_wet: &run.roads.wet,
                    sa1_grid: &n.census.sa1_grid, sa1_pop: &sa1_pop, sa1_land: &n.census.sa1_land, sa2_grid: &n.census.sa2_grid, sa2_workers: &sa2_workers,
                    road_lat: &n.census.road_lat, road_lon: &n.census.road_lon, road_off: &n.census.road_off,
                }))
            })??;
            o.f32s("bDepth", &r.b_depth).u8s("bFlood", &r.b_flood).u8s("iso", &r.iso)
                .i32s("cutEdges", &r.cut_edges).i32s("islandEdges", &r.island_edges)
                .f64s("roadCutKm", &r.road_cut_km)
                .f64s("n", &[r.b_wet as f64, r.b_deep as f64, r.h_wet as f64, r.work_wet as f64, r.isolated_b as f64, r.people, r.people_isolated, r.workers, r.workers_all, r.road_km]);
        }
        "netAccess" => {
            let r = with_net(b.num("net"), |n| -> Result<access::AccessOut, String> {
                let (g, bl) = (n.grid.as_ref().ok_or("the grid is not set")?, n.buildings.as_ref().ok_or("the buildings are not set")?);
                let (wet, deep, edge_name) = (b.u32s("wet").unwrap_or_default(), b.u32s("deep").unwrap_or_default(), b.i32s("edgeName").unwrap_or_default());
                Ok(access::access_over_time(&access::AccessIn {
                    steps: b.num("steps") as usize, wps: b.num("wps") as usize, n_cells: g.geo.w * g.geo.h, n_names: b.num("names") as usize,
                    off: &n.off, to: &n.to, edge: &n.edge, node_cell: &g.node_cell, exit: &g.exit, dry_reach: &g.dry_reach,
                    ce_off: &g.cell_edge_off, ce_list: &g.cell_edge, edge_name: &edge_name,
                    b_cell: &bl.b_cell, b_count: &bl.count, node_off: &bl.node_off, node_list: &bl.node_list, wet: &wet, deep: &deep,
                }))
            })??;
            o.i32s("closedCount", &r.closed_count).i32s("floodCount", &r.flood_count).i32s("isoCount", &r.iso_count)
                .i16s("isoSteps", &r.iso_steps).i16s("firstIso", &r.first_iso).num("longest", r.longest as f64)
                .i32s("nameCounts", &r.name_counts).i32s("nameIds", &r.name_ids);
        }
        "syntheticTerrain" => {
            put_grid(&mut o, &synthetic_terrain(b.num("W") as usize, b.num("H") as usize, b.num("cell"), b.num("seed") as u32));
        }
        "parseAsciiGrid" => {
            let text = String::from_utf8_lossy(&b.u8s("text").unwrap_or_default()).into_owned();
            put_grid(&mut o, &parse_ascii_grid(&text)?);
        }
        "downsample" => {
            put_grid(&mut o, &downsample(&grid_of(b)?, b.num("maxSide") as usize));
        }
        "cleanNodata" => {
            let mut g = grid_of(b)?;
            clean_nodata(&mut g, b.num("nodata"));
            o.u8s("valid", g.valid.as_deref().unwrap_or(&[]));
        }
        "lineCells" => {
            let flat = b.f64s("pts").unwrap_or_default();
            let pts: Vec<(f64, f64)> = flat.chunks(2).map(|p| (p[0], p[1])).collect();
            o.i32s("cells", &line_cells(&pts, b.num("W") as usize, b.num("H") as usize));
        }
        "stormUplift" => {
            o.num("v", storm_uplift(b.num("hours"), b.num("warming")));
        }
        "hazardClass" => {
            o.num("v", hazard_class(b.num("d"), b.num("v")) as f64);
        }
        "snapToStream" => {
            let v = with_analysis(b.num("a"), |a| snap_to_stream(a, b.num("x") as i64, b.num("y") as i64, b.num("r") as i64, b.num("minAcc")))?;
            o.num("v", v as f64);
        }
        "mainStem" => {
            o.i32s("cells", &with_analysis(b.num("a"), main_stem)?);
        }
        "encodeWhiteboxD8" => {
            o.i16s("codes", &with_analysis(b.num("a"), encode_whitebox_d8)?);
        }
        "mergeRuns" => {
            let (r1, r2) = (run_of(b, "a")?, run_of(b, "b")?);
            put_run(&mut o, &merge_runs(&r1, &r2), true);
        }
        "scoreRun" => {
            let (wet, near, flood) = (b.u8s("wet").unwrap_or_default(), b.u8s("near").unwrap_or_default(), b.u8s("flood").unwrap_or_default());
            let (hit, miss, fa) = with_analysis(b.num("a"), |a| score_run(a, &wet, &near, &flood))?;
            o.num("hit", hit as f64).num("miss", miss as f64).num("fa", fa as f64);
        }
        "inundateAt" => {
            let s = scenario_of(b);
            let cell = b.num("cell");
            let d = with_analysis(b.num("a"), |a| if cell >= 0.0 { probe(a, &s, cell as usize) } else { None })?;
            o.num("wet", if d.is_some() { 1.0 } else { 0.0 }).num("depth", d.unwrap_or(0.0) as f64);
        }
        "flashFlood" => {
            let st = Storm {
                rain_mm: b.num("rainMm"),
                hours: b.num("hours"),
                initial_loss: b.num("initialLoss"),
                cont_loss: b.num("contLoss"),
                n_channel: b.num("nChannel"),
                n_overland: b.num("nOverland"),
                max_rise: b.num("maxRise"),
                max_pond_depth: b.num("maxPondDepth"),
                pipe_mm_h: b.num("pipeMmH"),
                urban: b.u8s("urban"),
            };
            let r = with_analysis(b.num("a"), |a| flash_flood(a, &st))?;
            put_run(&mut o, &r, b.has("slim"));
        }
        "stats" => {
            let run = run_of(b, "")?;
            let base = if b.has("basewet") { Some(run_of(b, "base")?) } else { None };
            let s = with_analysis(b.num("a"), |a| stats(a, &run, base.as_ref()))?;
            o.num("wetLandKm2", s.wet_land_km2)
                .num("floodedKm2", s.flooded_km2)
                .num("deepKm2", s.deep_km2)
                .num("maxDepth", s.max_depth)
                .num("rawMaxDepth", s.raw_max_depth)
                .num("meanDepth", s.mean_depth);
        }
        "hazard" => {
            let run = run_of(b, "")?;
            let vx = b.f64s("vx");
            let vy = b.f64s("vy");
            let hz = with_analysis(b.num("a"), |a| hazard_with_velocities(a, &run, vx.as_deref(), vy.as_deref()))?;
            o.u8s("cls", &hz.cls).f32s("vel", &hz.vel).f64s("km2", &hz.km2);
        }
        "compareRuns" => {
            let now = run_of(b, "")?;
            let pinned = run_of(b, "pin")?;
            let c = with_analysis(b.num("a"), |a| compare_runs(a, &now, &pinned))?;
            o.u8s("diff", &c.diff)
                .f32s("dDepth", &c.d_depth)
                .num("both", c.both_km2)
                .num("onlyNow", c.only_now_km2)
                .num("onlyPinned", c.only_pinned_km2)
                .num("deeperKm2", c.deeper_km2)
                .num("shallowerKm2", c.shallower_km2);
        }
        "waveSetup" => {
            let s = scenario_of(b);
            let wo = wave_opts_of(b);
            let w = with_analysis(b.num("a"), |a| wave_setup(a, &s, &wo))?;
            put_wave(&mut o, &w);
            let h = WAVES.with(|x| store(x, w));
            o.num("handle", h as f64);
        }
        "waveAt" => {
            // kind: 0 gauge, 1 sea, 2 band b
            let ts = b.f64s("t").unwrap_or_default();
            let (kind, band) = (b.num("kind"), b.num("band"));
            let v = with_wave(b.num("w"), |w| {
                ts.iter()
                    .map(|&t| if kind == 0.0 { w.gauge_at(t) } else if kind == 1.0 { w.bay_at(t) } else { w.at(band as usize, t) })
                    .collect::<Vec<f64>>()
            })?;
            o.f64s("v", &v);
        }
        "waveSurface" => {
            let t = b.num("t");
            let v = with_wave(b.num("w"), |w| {
                let mut full = vec![f64::NAN; w.w0.len()];
                wave_surface(w, t, &mut full);
                w.cells.iter().map(|&c| full[c as usize]).collect::<Vec<f64>>()
            })?;
            o.f64s("v", &v);
        }
        "floodTimeline" => {
            let s = scenario_of(b);
            let wo = wave_opts_of(b);
            let tl = with_analysis(b.num("a"), |a| flood_timeline(a, &s, &wo))?;
            o.num("t0", tl.t0)
                .num("step", tl.step)
                .num("steps", tl.steps as f64)
                .i16s("firstWet", &tl.first_wet)
                .i16s("lastWet", &tl.last_wet)
                .i16s("firstDeep", &tl.first_deep)
                .i16s("lastDeep", &tl.last_deep)
                .i32s("wetCount", &tl.wet_count)
                .f32s("gauge", &tl.gauge)
                .num("wordsPerStep", tl.words_per_step as f64)
                .u32s("wetBits", &tl.wet_bits)
                .u32s("deepBits", &tl.deep_bits)
                .u8s("depthFrames", &tl.depth_frames)
                .f32s("depthFrameMax", &tl.depth_frame_max);
        }
        "burnDefences" => {
            let g = grid_of(b)?;
            o.f32s("dem", &burn_defences(&g, &levees_of(b)));
        }
        "terrainRGBA" => {
            let size = |k: &str| -> Result<usize, String> {
                let v = b.num(k);
                if v.is_finite() && v >= 1.0 && v.fract() == 0.0 { Ok(v as usize) } else { Err(format!("terrainRGBA: {} must be a whole number", k)) }
            };
            let stops = b.f64s("stops").ok_or("terrainRGBA: missing stops")?;
            if stops.len() % 4 != 0 { return Err("terrainRGBA: stops are rows of position, r, g, b".into()); }
            let stops: Vec<[f64; 4]> = stops.chunks(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
            let (dem, valid) = (b.f32s("dem").ok_or("terrainRGBA: missing dem")?, b.u8s("valid").ok_or("terrainRGBA: missing valid")?);
            let ocean = b.u8s("ocean");
            let rgba = terrain_rgba(size("W")?, size("H")?, b.num("cell"), &dem, &valid, ocean.as_deref(), &stops)?;
            o.u8s("rgba", &rgba);
        }
        "classifyDemGaps" => {
            let mut dem = b.f32s("dem").ok_or("classifyDemGaps: missing dem")?;
            let size = |k: &str| -> Result<usize, String> {
                let v = b.num(k);
                if v.is_finite() && v >= 0.0 && v.fract() == 0.0 { Ok(v as usize) } else { Err(format!("classifyDemGaps: {} must be a whole number", k)) }
            };
            let shore = b.num("shoreMax");
            let g = classify_dem_gaps(&mut dem, size("W")?, size("H")?, if shore.is_nan() { SEA_SHORE_MAX_M } else { shore })?;
            o.f32s("dem", &dem).u8s("sea", &g.sea).num("seaCells", g.sea_cells as f64).num("filledCells", g.filled_cells as f64).num("gaps", g.gaps as f64);
        }
        "fineRaster" => {
            let need = |k: &str| b.u8s(k).ok_or_else(|| format!("fineRaster: missing {}", k));
            let nums = |k: &str, n: usize| -> Result<Vec<f64>, String> {
                let v = b.f64s(k).ok_or_else(|| format!("fineRaster: missing {}", k))?;
                if v.len() == n { Ok(v) } else { Err(format!("fineRaster: {} needs {} numbers", k, n)) }
            };
            let (bbox, extent) = (nums("box", 4)?, nums("extent", 4)?);
            let (lidar, dem, depth) = (b.f32s("lidar").ok_or("fineRaster: missing lidar")?, b.f32s("dem").ok_or("fineRaster: missing dem")?, b.f32s("depth").ok_or("fineRaster: missing depth")?);
            let (valid, ocean, wet, coarse) = (need("valid")?, need("ocean")?, need("wet")?, need("coarse")?);
            let (level, base_depth, hz_vel) = (b.f32s("level"), b.f32s("baseDepth"), b.f32s("hzVel"));
            let (base_wet, hz_cls) = (b.u8s("baseWet"), b.u8s("hzCls"));
            let (depth_limits, depth_colors, hazard_colors, hazard_limits) = (b.f64s("depthLimits").ok_or("fineRaster: missing depthLimits")?, need("depthColors")?, need("hazardColors")?, b.f64s("hazardLimits").ok_or("fineRaster: missing hazardLimits")?);
            let water = need("water")?;
            if water.len() != 3 {
                return Err("fineRaster: water needs 3 values".into());
            }
            let size = |k: &str| -> Result<usize, String> {
                let v = b.num(k);
                if v.is_finite() && v >= 0.0 && v.fract() == 0.0 { Ok(v as usize) } else { Err(format!("fineRaster: {} must be a whole number", k)) }
            };
            let (w, h, a_w, a_h, x0, y0, ww) = (size("W")?, size("H")?, size("aW")?, size("aH")?, size("x0")?, size("y0")?, size("ww")?);
            let (row_from, row_to) = (if b.has("rowFrom") { size("rowFrom")? } else { 0 }, if b.has("rowTo") { size("rowTo")? } else { h });
            let (rgba, have) = fine_raster(&Fine {
                w, h, row_from, row_to, bbox: [bbox[0], bbox[1], bbox[2], bbox[3]], extent: [extent[0], extent[1], extent[2], extent[3]], a_w, a_h, x0, y0, ww,
                lidar: &lidar, nodata: b.num("nd"), dem: &dem, valid: &valid, ocean: &ocean, wet: &wet, depth: &depth,
                level: level.as_deref(), base_wet: base_wet.as_deref(), base_depth: base_depth.as_deref(), hz_cls: hz_cls.as_deref(), hz_vel: hz_vel.as_deref(),
                coarse: &coarse, depth_limits: &depth_limits, depth_colors: &depth_colors, depth_alpha0: b.num("depthAlpha0") as u8,
                water: [water[0], water[1], water[2]], channel_alpha: b.num("channelAlpha") as u8, hazard_colors: &hazard_colors, hazard_limits: &hazard_limits,
            })?;
            o.u8s("rgba", &rgba).num("have", have as f64);
        }
        "parseSimpleTiff" => {
            let bytes = b.u8s("bytes").ok_or("no bytes")?;
            let t = parse_simple_tiff(&bytes)?;
            o.num("W", t.w as f64).num("H", t.h as f64).f32s("data", &t.data);
            o.num("nodata", t.nodata);
            if let Some(bd) = t.bounds {
                o.f64s("bounds", &bd);
            }
        }
        _ => return Err(format!("unknown operation {}", op)),
    }
    Ok(o.finish())
}

/// Space for JavaScript to write into.
#[no_mangle]
pub extern "C" fn flood_alloc(n: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` must come from `flood_alloc(n)` and not be used again.
#[no_mangle]
pub unsafe extern "C" fn flood_free(p: *mut u8, n: usize) {
    drop(Vec::from_raw_parts(p, 0, n.max(1)));
}

/// Run an operation; returns a pointer to the output bag (valid until the
/// next call), its length from `flood_out_len`. On failure the bag holds "error".
///
/// # Safety
/// The pointers must point at `op_len` and `in_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn flood_run(op: *const u8, op_len: usize, inp: *const u8, in_len: usize) -> *const u8 {
    let op = String::from_utf8_lossy(std::slice::from_raw_parts(op, op_len)).into_owned();
    let input = if in_len > 0 { std::slice::from_raw_parts(inp, in_len) } else { &[] };
    let bag = Bag::decode(input);
    let res = dispatch(&op, &bag).unwrap_or_else(|e| {
        let mut o = Out::default();
        o.u8s("error", e.as_bytes());
        o.finish()
    });
    OUT.with(|x| {
        *x.borrow_mut() = res;
        x.borrow().as_ptr()
    })
}

#[no_mangle]
pub extern "C" fn flood_out_len() -> usize {
    OUT.with(|x| x.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bags_round_trip_and_analyse_runs() {
        let g = sample_terrain();
        let mut o = Out::default();
        o.num("W", g.w as f64).num("H", g.h as f64).num("cell", g.cell).f32s("dem", &g.dem);
        if let Some(v) = &g.inflow {
            o.f32s("inflow", v);
        }
        let b = Bag::decode(&o.finish());
        let out = Bag::decode(&dispatch("analyse", &b).unwrap());
        assert_eq!(out.num("N"), (g.w * g.h) as f64);
        let a = analyse(&g, 4.0);
        assert_eq!(out.f64s("acc").unwrap(), a.acc);
        assert_eq!(out.num("defaultGauge"), a.default_gauge as f64);
        let h = out.num("handle");
        let mut o = Out::default();
        o.num("a", h).num("gauge", a.default_gauge as f64).num("gaugeLevel", 4.46).num("bayLevel", 1.0).num("upstreamGradient", 0.3);
        let r = Bag::decode(&dispatch("inundate", &Bag::decode(&o.finish())).unwrap());
        let s = Scenario { gauge: a.default_gauge, gauge_level: 4.46, bay_level: 1.0, upstream_gradient: 0.3, ..Default::default() };
        assert_eq!(r.u8s("wet").unwrap(), inundate(&a, &s).wet);
        assert!(dispatch("nope", &b).is_err());
    }
}
