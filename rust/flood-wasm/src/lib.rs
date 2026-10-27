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
    static TSUNAMI: RefCell<Option<tsunami::Solver>> = const { RefCell::new(None) };
    static ANALYSES: RefCell<Vec<Option<Analysis>>> = const { RefCell::new(Vec::new()) };
    static WAVES: RefCell<Vec<Option<Wave>>> = const { RefCell::new(Vec::new()) };
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

/// Run one operation. Errors come back as a bag with "error" (UTF-8 bytes).
pub fn dispatch(op: &str, b: &Bag) -> Result<Vec<u8>, String> {
    let mut o = Out::default();
    match op {
        "tsunamiStart" => {
            TSUNAMI.with(|s| *s.borrow_mut() = None);
            INUNDATION.with(|s| *s.borrow_mut() = None);
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
                if let Some(end) = solver.forcing_end() { o.num("forcingEnd", end); }
                o.num("dt", solver.dt);
                INUNDATION.with(|s| *s.borrow_mut() = Some(solver));
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
            let nonlinear = INUNDATION.with(|slot| -> Result<bool, String> {
                let mut slot = slot.borrow_mut();
                let Some(s) = slot.as_mut() else { return Ok(false); };
                s.advance(steps as usize)?;
                o.num("time", s.time).num("dt", s.dt).num("volume", s.volume())
                    .num("volumeError", s.volume_error()).num("boundaryVolume", s.boundary_volume);
                for (name, values) in [("eta", &s.eta), ("peak", &s.peak), ("water", &s.water), ("speed", &s.speed)] {
                    o.f32s(name, &values.iter().map(|v| *v as f32).collect::<Vec<_>>());
                }
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
